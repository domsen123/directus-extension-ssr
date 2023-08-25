import path from 'node:path'
import process from 'node:process'
import { readFileSync } from 'node:fs'
import { defineHook } from '@directus/extensions-sdk'
import { static as serveStatic } from 'express'
import ms from 'ms'
import devalue from '@nuxt/devalue'
import type { Application } from 'express'
import type { ViteDevServer } from 'vite'
import type { AuthenticationData } from '@directus/sdk'
import type { InitialState, RenderFn, RenderResult } from '../types'

const DIRECTUS_ROUTES = [
  '/server/ping',
  '/admin',
  '/auth',
  '/graphql',
  '/activity',
  '/assets',
  '/collections',
  '/dashboards',
  '/extensions',
  '/fields',
  '/files',
  '/flows',
  '/folders',
  '/items',
  '/notifications',
  '/operations',
  '/panels',
  '/permissions',
  '/presets',
  '/translations',
  '/relations',
  '/revisions',
  '/roles',
  '/schema',
  '/server',
  '/settings',
  '/shares',
  '/users',
  '/utils',
  '/webhooks',
]

/**
 * Safely parse human readable time format into milliseconds
 */
export function getMilliseconds<T>(value: unknown, fallback?: T): number | T
export function getMilliseconds(value: unknown, fallback = undefined): number | undefined {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '')
    return fallback

  return ms(String(value)) ?? fallback
}

export const config = defineHook(async ({ init }, { env }) => {
  init('routes.custom.after', async (ctx) => {
    const app: Application = ctx.app

    const isDev = env.SSR_ENV === 'development'

    const resolve = (p: string) => path.resolve(process.cwd(), p)

    const indexProd = isDev ? '' : readFileSync(resolve('dist/client/index.html'), 'utf-8')
    const manifest = isDev ? {} : JSON.parse(readFileSync(resolve('dist/client/ssr-manifest.json'), 'utf-8'))

    let vite: ViteDevServer
    if (isDev) {
      vite = await (await import('vite')).createServer({
        root: process.cwd(),
        server: {
          middlewareMode: true,
        },
        appType: 'custom',
      })
      app.use(vite.middlewares)
    }
    else {
      app.use(serveStatic(resolve('dist/client'), { index: false }))
    }

    app.use('*', async (req, res, next) => {
      if (
        DIRECTUS_ROUTES.includes(req.originalUrl)
        || req.method !== 'GET'
      ) {
        return next()
      }
      else {
        try {
          const url = req.originalUrl

          let template: string
          let render: RenderFn

          if (isDev) {
            template = readFileSync(resolve('index.html'), 'utf-8')
            template = await vite.transformIndexHtml(url, template)
            render = await (await vite.ssrLoadModule('/src/main.ts')).default
          }
          else {
            template = indexProd
            render = await (await import(resolve('dist/server/main.mjs'))).default
          }
          const initialState: InitialState = {
            access_token: null,
            directusCredentials: null,
          }

          const {
            appHtml,
            preloadedLinks,
            appParts: { headTags, htmlAttrs, bodyAttrs, bodyTags },
            directus,
          } = await render({
            skipRender: false,
            url,
            manifest,
            initialState,
            req,
            res,
            env,
          }) as RenderResult

          let directusCredentials: AuthenticationData | null = null

          try {
            directusCredentials = await directus.getCredentials()

            if (directus && directusCredentials?.refresh_token) {
              const cookieOptions = {
                httpOnly: true,
                domain: env.REFRESH_TOKEN_COOKIE_DOMAIN,
                maxAge: getMilliseconds<number>(env.REFRESH_TOKEN_TTL),
                secure: env.REFRESH_TOKEN_COOKIE_SECURE ?? false,
                sameSite: (env.REFRESH_TOKEN_COOKIE_SAME_SITE as 'lax' | 'strict' | 'none') || 'strict',
              }
              res.cookie(env.REFRESH_TOKEN_COOKIE_NAME, directusCredentials.refresh_token, cookieOptions)
            }
            else {
              res.clearCookie(env.REFRESH_TOKEN_COOKIE_NAME)
            }
          }
          catch (error: any) {
            res.clearCookie(env.REFRESH_TOKEN_COOKIE_NAME)
          }

          const state = {
            ...initialState,
            directusCredentials,
          }
          const __INITIAL_STATE__ = `  <script>window.__INITIAL_STATE__ = ${devalue(state)}</script>`

          const html = template
            .replace('<html', `<html ${htmlAttrs}`)
            .replace('<!--preload-links-->', `${preloadedLinks}\n${headTags}`)
            .replace('<!--app-html-->', appHtml)
            .replace('<body', `<body${bodyAttrs}`)
            .replace('</body>', `${bodyTags}\n${__INITIAL_STATE__}\n</body>`)

          res.removeHeader('Content-Security-Policy')
          res.status(200).set({
            'Content-Type': 'text/html',
          }).end(html)
        }
        catch (error: any) {
          vite && vite.ssrFixStacktrace(error)
          console.error('global-error', error)
          res.status(500).send(error.stack || error)
        }
      }
    })
  })
})
