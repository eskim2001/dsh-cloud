import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { BrandMark } from '@/components/brand-mark.js'
import { LanguageSwitcher } from '@/components/language-switcher.js'
import { ThemeSwitcher } from '@/components/theme-switcher.js'
import { Alert, AlertDescription } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent } from '@/components/ui/card.js'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.js'
import { ApiError, signIn, signUp } from '../lib/api.js'
import { sessionKey } from '../lib/use-session.js'

type Mode = 'signin' | 'signup'

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === 'signup') return await signUp(email, password, name === '' ? email : name)
      return await signIn(email, password)
    },
    onSuccess: (user) => {
      // 直接写进缓存再跳转：否则 RequireAuth 会先看到旧的 null 把人弹回来
      queryClient.setQueryData(sessionKey, user)
      const raw = params.get('next')
      const next = raw === null ? '/' : safeNext(raw)
      // 跨子域（登录页在基域、实例在子域）只能整页跳，react-router 不管这个
      if (next.startsWith('/')) navigate(next, { replace: true })
      else window.location.assign(next)
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    mutation.mutate()
  }

  return (
    <div className="relative flex min-h-full items-center justify-center p-6">
      <div className="absolute top-4 right-4 flex items-center gap-1">
        <LanguageSwitcher />
        <ThemeSwitcher />
      </div>

      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3">
          <BrandMark className="size-12" />
          <div className="flex flex-col items-center gap-1">
            <h1 className="font-heading text-xl font-semibold">
              dsh-<span className="text-muted-foreground">cloud</span>
            </h1>
            <p className="text-sm text-muted-foreground">{t('login.subtitle')}</p>
          </div>
        </div>

        <Card>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <ToggleGroup
                value={[mode]}
                onValueChange={(value) => {
                  const next = value[0]
                  if (next === 'signin' || next === 'signup') setMode(next)
                }}
                className="w-full"
              >
                <ToggleGroupItem value="signin" className="flex-1">
                  {t('login.tabSignIn')}
                </ToggleGroupItem>
                <ToggleGroupItem value="signup" className="flex-1">
                  {t('login.tabSignUp')}
                </ToggleGroupItem>
              </ToggleGroup>

              <FieldGroup>
                {mode === 'signup' && (
                  <Field>
                    <FieldLabel htmlFor="name">{t('login.name')}</FieldLabel>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t('login.namePlaceholder')}
                      autoComplete="name"
                    />
                  </Field>
                )}

                <Field>
                  <FieldLabel htmlFor="email">{t('login.email')}</FieldLabel>
                  <Input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="password">{t('login.password')}</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  />
                </Field>
              </FieldGroup>

              {mutation.isError && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {mutation.error instanceof ApiError
                      ? mutation.error.message
                      : t('common.requestFailed')}
                  </AlertDescription>
                </Alert>
              )}

              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending
                  ? t('login.pending')
                  : mode === 'signin'
                    ? t('login.submitSignIn')
                    : t('login.submitSignUp')}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/**
 * `next` 来自 URL，别让它变成开放重定向。放行两类：
 *  - 站内相对路径（`/xxx`，但 `//xxx` 是协议相对 URL，要挡）；
 *  - **本域或本域子域的绝对 URL**——forward-auth 挡下的实例地址就是这种：
 *    登录页在基域（`localhost` / `app.example.com`），实例在子域
 *    （`u1t.localhost` / `u1t.app.example.com`），跨子域是正常流程。
 */
function safeNext(next: string): string {
  if (next.startsWith('/') && !next.startsWith('//')) return next
  try {
    const url = new URL(next)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '/'
    const here = window.location.hostname
    if (url.hostname === here || url.hostname.endsWith(`.${here}`)) return url.toString()
  } catch {
    // 不是合法 URL，按拒绝处理
  }
  return '/'
}
