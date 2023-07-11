import type { InjectionKey } from 'vue'
import { createSSRApp } from 'vue'
import { createMemoryHistory, createRouter, createWebHistory } from 'vue-router'
import { createHead } from '@vueuse/head'
import type { IAuth } from '@directus/sdk'
import { Directus } from '@directus/sdk'
import type { Request } from 'express'
import type { AppDirectus, AppTypeMap, SharedHandler } from '../types'

export const DirectusKey: InjectionKey<AppDirectus> = Symbol('directus')

const getDirectus = (isClient: boolean): AppDirectus => {
  const isServer = !isClient
  const PUBLIC_URL = isServer ? process.env.PUBLIC_URL as string : `${new URL(window.location.href).origin}/`
  return new Directus<AppTypeMap, IAuth>(PUBLIC_URL, {
    auth: {
      mode: isServer ? 'json' : 'cookie',
    },
    storage: {
      mode: isServer ? 'MemoryStorage' : 'LocalStorage',
    },
  })
}

export const getCookieValue = (req: Request, cookieName: string): string | null => {
  const cookieHeader = req.headers.cookie
  if (cookieHeader) {
    const cookies = cookieHeader.split('; ')
    for (const cookie of cookies) {
      const [name, value] = cookie.split('=')
      if (name === cookieName)
        return value
    }
  }
  return null
}

export const createApp: SharedHandler = async (App, options, hook) => {
  const { isClient, routes, initialState } = options

  const directus = getDirectus(isClient)

  try {
    if (!isClient) {
      const { req, env } = options
      const refresh_token = getCookieValue(req, env.REFRESH_TOKEN_COOKIE_NAME)
      if (refresh_token) {
        directus.storage.set('auth_refresh_token', refresh_token)
        await directus.auth.refresh()
      }
    }
    else {
      directus.storage.set('auth_token', initialState.access_token || '')
      if (initialState.access_token)
        await directus.auth.refresh()
    }
  }
  catch (error: any) {
    console.error(error.message)
  }

  const app = createSSRApp(App)
  app.provide(DirectusKey, directus)

  const router = createRouter({
    history: !isClient ? createMemoryHistory() : createWebHistory(),
    routes: [
      ...routes,
    ],
  })

  const head = createHead()
  app.use(head)

  hook && await hook({ app, router, directus })

  return {
    app,
    router,
    head,
    directus,
  }
}