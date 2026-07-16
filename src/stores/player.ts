import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { fetchLyricsCached } from '../utils/lrc'
import { api } from '../utils/api'

export type Track = {
  trackId: string
  name: string
  artist: string
  format?: string
  fileSize?: number
  mediaUrl?: string
  urlExpiresAt?: string
}

// 三态播放模式：列表循环 -> 单曲循环 -> 随机播放 -> 列表循环。
export type PlayMode = 'list' | 'one' | 'shuffle'

const MODE_STORAGE_KEY = 'player.mode'
const VOLUME_STORAGE_KEY = 'player.volume'
const MODE_ORDER: PlayMode[] = ['list', 'one', 'shuffle']

function readInitialMode(): PlayMode {
  if (typeof window === 'undefined') return 'list'
  const saved = window.localStorage.getItem(MODE_STORAGE_KEY)
  if (saved === 'list' || saved === 'one' || saved === 'shuffle') return saved
  return 'list'
}

// 单例音频对象：Vue 组件卸载不影响播放，符合桌面/移动端持久播放心理预期。
const audio: HTMLAudioElement | null =
  typeof window !== 'undefined' ? new Audio() : null
if (audio) audio.preload = 'metadata'

// 用于取消上一次未完成的切歌就绪回调
let pendingReady: (() => void) | null = null

// Android Wake Lock: 播放时阻止屏幕休眠（车机/导航场景）
let wakeLockSentinel: WakeLockSentinel | null = null

async function requestWakeLock() {
  try {
    if (wakeLockSentinel) return
    wakeLockSentinel = await navigator.wakeLock.request('screen')
    wakeLockSentinel.onrelease = () => { wakeLockSentinel = null }
  } catch { /* Wake Lock 不可用时不阻塞 */ }
}

async function releaseWakeLock() {
  if (wakeLockSentinel) {
    try { await wakeLockSentinel.release() } catch {}
    wakeLockSentinel = null
  }
}

// 前端直链缓存：trackId -> { url, format, expiresAt }
const urlCache = new Map<string, { url: string; format: string; expiresAt: number }>()

async function fetchMediaUrl(trackId: string): Promise<{ url: string; format: string } | null> {
  // 先查缓存
  const cached = urlCache.get(trackId)
  if (cached && Date.now() < cached.expiresAt) return { url: cached.url, format: cached.format }
  try {
    const payload = await api.get(`/api/v1/tracks/${trackId}/media-url`)
    if (!payload.success || !payload.data?.mediaUrl) return null
    const expiresAt = payload.data.expiresAt
      ? new Date(payload.data.expiresAt).getTime()
      : Date.now() + 3.5 * 60 * 60 * 1000
    urlCache.set(trackId, { url: payload.data.mediaUrl, format: payload.data.format || '', expiresAt })
    return { url: payload.data.mediaUrl, format: payload.data.format || '' }
  } catch {
    return null
  }
}

// 批量获取直链
async function fetchMediaUrls(trackIds: string[]): Promise<Map<string, { url: string; format: string }>> {
  const result = new Map<string, { url: string; format: string }>()
  
  // 过滤出需要请求的ID（缓存中没有或已过期）
  const idsToFetch: string[] = []
  for (const id of trackIds) {
    const cached = urlCache.get(id)
    if (cached && Date.now() < cached.expiresAt) {
      result.set(id, { url: cached.url, format: cached.format })
    } else {
      idsToFetch.push(id)
    }
  }
  
  if (idsToFetch.length === 0) return result
  
  try {
    const payload = await api.get('/api/v1/tracks/media-urls', { ids: idsToFetch.join(',') })
    if (payload.success && payload.data) {
      for (const [trackId, data] of Object.entries(payload.data)) {
        const mediaData = data as { mediaUrl: string; format?: string; expiresAt?: string }
        if (mediaData.mediaUrl) {
          const expiresAt = mediaData.expiresAt
            ? new Date(mediaData.expiresAt).getTime()
            : Date.now() + 3.5 * 60 * 60 * 1000
          urlCache.set(trackId, { url: mediaData.mediaUrl, format: mediaData.format || '', expiresAt })
          result.set(trackId, { url: mediaData.mediaUrl, format: mediaData.format || '' })
        }
      }
    }
  } catch {
    // 批量获取失败，回退到单个获取
    for (const id of idsToFetch) {
      const singleResult = await fetchMediaUrl(id)
      if (singleResult) {
        result.set(id, singleResult)
      }
    }
  }
  
  return result
}

async function prefetchNextUrls(tracks: Track[], currentIdx: number) {
  // 预取接下来3首的直链
  const prefetchCount = 3
  const idsToPrefetch: string[] = []
  
  for (let i = 1; i <= prefetchCount; i++) {
    const idx = (currentIdx + i) % tracks.length
    const track = tracks[idx]
    if (track?.trackId && !track.mediaUrl) {
      idsToPrefetch.push(track.trackId)
    }
  }
  
  if (idsToPrefetch.length === 0) return
  
  const urlMap = await fetchMediaUrls(idsToPrefetch)
  
  // 回写到队列
  for (let i = 1; i <= prefetchCount; i++) {
    const idx = (currentIdx + i) % tracks.length
    const track = tracks[idx]
    if (track?.trackId) {
      const urlData = urlMap.get(track.trackId)
      if (urlData) {
        tracks[idx] = { ...tracks[idx], mediaUrl: urlData.url }
      }
    }
  }
}


function updateMediaSession(track: Track) {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.name,
    artist: track.artist,
    artwork: [{ src: '/favicon.svg', sizes: '512x512', type: 'image/svg+xml' }]
  })
}

export const usePlayerStore = defineStore('player', () => {
  const queue = ref<Track[]>([])
  const currentIndex = ref(-1)
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref(0.85)
  const mode = ref<PlayMode>(readInitialMode())
  const loading = ref(false)
  let needsResume = false  // 后台切歌后需前台恢复播放

  const currentTrack = computed(() =>
    currentIndex.value >= 0 ? queue.value[currentIndex.value] : null
  )

  function setQueue(tracks: Track[], startIndex = 0) {
    queue.value = tracks
    if (!tracks.length) {
      currentIndex.value = -1
      stop()
      return
    }
    playIndex(Math.min(startIndex, tracks.length - 1))
  }

  function doPlay(url: string) {
    if (!audio) return
    if (pendingReady) {
      audio.removeEventListener('canplay', pendingReady)
      pendingReady = null
    }
    isPlaying.value = false
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    audio.src = url
    audio.currentTime = 0
    audio.volume = volume.value

    // 等待缓冲就绪后再播放（慢加载 URL 不急于立即 play）
    let played = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const tryPlay = () => {
      loading.value = false
      const p = audio.play()
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (audio.paused) isPlaying.value = false
        }).catch(() => {
          setTimeout(() => {
            audio.play().then(() => {
              if (audio.paused) isPlaying.value = false
            }).catch(() => {
              isPlaying.value = false
            })
          }, 600)
        })
      }
    }

    const onReady = () => {
      if (played) return
      played = true
      if (timeoutId) clearTimeout(timeoutId)
      audio.removeEventListener('canplay', onReady)
      pendingReady = null
      tryPlay()
    }

    pendingReady = onReady
    audio.addEventListener('canplay', onReady)

    timeoutId = setTimeout(() => {
      if (!played) {
        played = true
        audio.removeEventListener('canplay', onReady)
        pendingReady = null
        tryPlay()
      }
    }, 8000)
  }

  async function playIndex(index: number) {
    if (!audio) return
    if (index < 0 || index >= queue.value.length) return
    currentIndex.value = index
    const track = queue.value[index]
    if (!track) return

    // 蓝奏云 CDN 支持无 User-Agent 请求，直接用直链播放
    loading.value = true
    isPlaying.value = false
    if (track.mediaUrl) {
      doPlay(track.mediaUrl)
      updateMediaSession(track)
      prefetchNextUrls(queue.value, index)
      fetchLyricsCached(track.trackId)
      return
    }
    // 没有直链则通过 API 获取
    const result = await fetchMediaUrl(track.trackId)
    if (!result) {
      isPlaying.value = false
      loading.value = false
      return
    }
    queue.value = queue.value.map((t, i) => i === index ? { ...t, mediaUrl: result.url } : t)
    doPlay(result.url)
    updateMediaSession(track)
    prefetchNextUrls(queue.value, index)
    fetchLyricsCached(track.trackId)
  }

  function toggle() {
    if (!audio) return
    if (!currentTrack.value) {
      if (queue.value.length) playIndex(0)
      return
    }
    if (audio.paused) {
      audio.play().catch(() => {})
    } else {
      audio.pause()
    }
  }

  function stop() {
    if (!audio) return
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    isPlaying.value = false
    currentTime.value = 0
    duration.value = 0
  }

  function pickShuffleIndex(): number {
    if (queue.value.length <= 1) return 0
    let next = currentIndex.value
    while (next === currentIndex.value) {
      next = Math.floor(Math.random() * queue.value.length)
    }
    return next
  }

  function next(userTriggered = true) {
    if (!queue.value.length) return
    // 单曲循环仅在自然结束时生效，用户手动切歌应正常前进。
    if (!userTriggered && mode.value === 'one') {
      playIndex(currentIndex.value)
      return
    }
    if (mode.value === 'shuffle') {
      playIndex(pickShuffleIndex())
      return
    }
    const last = queue.value.length - 1
    if (currentIndex.value >= last) {
      // list 模式与手动下一曲：到末尾回到开头。
      playIndex(0)
      return
    }
    playIndex(currentIndex.value + 1)
  }

  function prev() {
    if (!queue.value.length) return
    // 3 秒后按上一曲视作重播当前曲，符合主流播放器交互。
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }
    if (mode.value === 'shuffle') {
      playIndex(pickShuffleIndex())
      return
    }
    if (currentIndex.value <= 0) {
      playIndex(queue.value.length - 1)
      return
    }
    playIndex(currentIndex.value - 1)
  }

  function seek(seconds: number) {
    if (!audio) return
    audio.currentTime = Math.max(0, Math.min(seconds, duration.value || seconds))
  }

  function setVolume(value: number) {
    volume.value = Math.max(0, Math.min(1, value))
    if (audio) audio.volume = volume.value
  }

  function cyclePlayMode() {
    mode.value = MODE_ORDER[(MODE_ORDER.indexOf(mode.value) + 1) % MODE_ORDER.length]
  }

  function setPlayMode(next: PlayMode) {
    mode.value = next
  }

  if (audio) {
    // Media Session API: 让 iOS 在锁屏/后台识别为媒体应用，保持音频会话活跃
    if ('mediaSession' in navigator) {
      // play 必须永远尝试播放（不 toggle），解决锁屏下 audio 僵尸状态
      // 用户按锁屏/方向盘播放键时强制重连音频会话
      navigator.mediaSession.setActionHandler('play', () => {
        if (currentTrack.value) {
          audio.play().catch(() => {})
        }
      })
      navigator.mediaSession.setActionHandler('pause', () => {
        if (!audio.paused) audio.pause()
      })
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        prev()
        updateMediaSession(currentTrack.value!)
        audio.play().catch(() => {})
      })
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        next(true)
        updateMediaSession(currentTrack.value!)
        audio.play().catch(() => {})
      })
      // 方向盘长按快进/快退（Android 车机硬件按键）
      navigator.mediaSession.setActionHandler('seekforward', () => {
        if (audio) audio.currentTime = Math.min(audio.currentTime + 10, audio.duration || 0)
      })
      navigator.mediaSession.setActionHandler('seekbackward', () => {
        if (audio) audio.currentTime = Math.max(audio.currentTime - 10, 0)
      })
    }

    audio.addEventListener('play', () => {
      isPlaying.value = true
      requestWakeLock()
    })
    audio.addEventListener('pause', () => {
      isPlaying.value = false
      releaseWakeLock()
    })
    audio.addEventListener('timeupdate', () => {
      currentTime.value = audio.currentTime
      // 更新 Media Session 播放位置，保持音频会话活跃
      if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
        try {
          navigator.mediaSession.setPositionState({
            duration: audio.duration || 0,
            playbackRate: audio.playbackRate || 1,
            position: audio.currentTime || 0,
          })
        } catch {}
      }
    })
    audio.addEventListener('loadedmetadata', () => {
      duration.value = audio.duration || 0
      loading.value = false
    })
    audio.addEventListener('canplay', () => {
      loading.value = false
    })
    audio.addEventListener('waiting', () => {
      loading.value = true
    })
    audio.addEventListener('ended', () => {
      next(false)
      // 锁屏/后台切歌标记：iOS 可能接受 play() 但不输出声音
      if (document.hidden) {
        needsResume = true
      }
    })
    audio.addEventListener('error', () => {
      loading.value = false
      isPlaying.value = false
    })

    // iOS PWA 后台切歌恢复：回到前台时若需要恢复播放，pause+play 重连音频输出
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && needsResume && currentTrack.value) {
        needsResume = false
        // 短暂暂停再播放，强制 iOS 重连音频会话
        audio.pause()
        setTimeout(() => {
          audio.play().catch(() => {})
        }, 50)
      }
    })
  }

  // 音量持久化，避免刷新后回到默认值影响耳机用户体验。
  const persisted = typeof window !== 'undefined'
    ? Number(window.localStorage.getItem(VOLUME_STORAGE_KEY))
    : NaN
  if (!Number.isNaN(persisted) && persisted > 0 && persisted <= 1) {
    setVolume(persisted)
  }
  watch(volume, (v) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(VOLUME_STORAGE_KEY, String(v))
    }
  })
  watch(mode, (m) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MODE_STORAGE_KEY, m)
    }
  })

  return {
    queue,
    currentIndex,
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    volume,
    mode,
    loading,
    setQueue,
    playIndex,
    toggle,
    next,
    prev,
    seek,
    setVolume,
    cyclePlayMode,
    setPlayMode,
  }
})
