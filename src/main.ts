import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'element-plus/dist/index.css'
import 'vant/lib/index.css'
import App from './App.vue'
import './styles.css'

// === 车机模式：根据 UA/屏幕宽高比自动检测 ===
const isCar = /car|pad|tablet|flyme|android(?!.*mobile)/i.test(navigator.userAgent)
  || (screen.width >= 1024 && screen.width / screen.height > 1.5)

if (isCar) {
  document.documentElement.classList.add('car-mode')
}

// iOS PWA 视口高度修正（Tauri 移动端 WebView 同样适用）
const fixBottomBar = () => {
  const diff = window.screen.height - window.innerHeight
  if (diff > 0) {
    document.documentElement.style.setProperty('--safe-bottom', diff + 'px')
  }
}
window.addEventListener('resize', fixBottomBar)
window.addEventListener('load', fixBottomBar)

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
