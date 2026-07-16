import { invoke } from '@tauri-apps/api/core'

export interface ApiResponse {
  success: boolean
  data?: any
  total?: number
  error?: { message?: string; code?: string }
  [key: string]: any
}

export const api = {
  async get(path: string, params?: Record<string, string>): Promise<ApiResponse> {
    const jsonStr = await invoke<string>('api_request', {
      method: 'GET',
      path,
      query: params || null,
      body: null,
    })
    return JSON.parse(jsonStr)
  },

  async post(path: string, body?: Record<string, any>): Promise<ApiResponse> {
    const jsonStr = await invoke<string>('api_request', {
      method: 'POST',
      path,
      query: null,
      body: body ? JSON.stringify(body) : null,
    })
    return JSON.parse(jsonStr)
  },
}
