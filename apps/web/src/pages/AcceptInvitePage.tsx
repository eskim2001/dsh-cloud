import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { BrandMark } from '@/components/brand-mark.js'
import { LanguageSwitcher } from '@/components/language-switcher.js'
import { ThemeSwitcher } from '@/components/theme-switcher.js'
import { Alert, AlertDescription } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent } from '@/components/ui/card.js'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import { ApiError, acceptInvitation, signIn } from '../lib/api.js'
import { sessionKey } from '../lib/use-session.js'

/**
 * 兑换邀请。**未登录可达**——这是新账号唯一的入口（公开注册已关闭）。
 *
 * 两步：先 `acceptInvitation` 把账号建出来，再 `signIn` 拿会话。之所以不在
 * 服务端一步到位建会话，是为了让**认证路径只保留一条**（见服务端
 * http/invitation-routes.ts）。两步之间失败的话账号其实已经建好了，
 * 所以要用 `phase` 把消息说准，别让用户对着 409 反复重试。
 */
export default function AcceptInvitePage() {
  const { token = '' } = useParams()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [phase, setPhase] = useState<'idle' | 'accepted'>('idle')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  const mutation = useMutation({
    mutationFn: async () => {
      const { email } = await acceptInvitation({
        token,
        password,
        ...(name.trim() === '' ? {} : { name: name.trim() }),
      })
      setPhase('accepted')
      return signIn(email, password)
    },
    onSuccess: (user) => {
      queryClient.setQueryData(sessionKey, user)
      navigate('/', { replace: true })
    },
  })

  const errorText =
    phase === 'accepted'
      ? t('invite.alreadyAccepted')
      : mutation.error instanceof ApiError
        ? mutation.error.message
        : t('common.requestFailed')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    mutation.mutate()
  }

  return (
    // 同 LoginPage：内容比视口高时靠容器滚动，别用 items-center 把顶上那截顶出可见区
    <div className="relative flex h-full justify-center overflow-y-auto p-6">
      <div className="absolute top-4 right-4 flex items-center gap-1">
        <LanguageSwitcher />
        <ThemeSwitcher />
      </div>

      <div className="my-auto flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3">
          <BrandMark className="size-12" />
          <div className="flex flex-col items-center gap-1">
            <h1 className="font-heading text-xl font-semibold">
              dsh-<span className="text-muted-foreground">cloud</span>
            </h1>
            <p className="text-sm text-muted-foreground">{t('invite.subtitle')}</p>
          </div>
        </div>

        <Card>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">{t('invite.intro')}</p>

              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="name">{t('invite.name')}</FieldLabel>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('invite.namePlaceholder')}
                    autoComplete="name"
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="password">{t('invite.password')}</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
              </FieldGroup>

              {mutation.isError && (
                <Alert variant="destructive">
                  <AlertDescription>{errorText}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? t('invite.pending') : t('invite.submit')}
              </Button>
            </form>
          </CardContent>
        </Card>

        {mutation.isError && phase === 'accepted' && (
          <Button variant="link" onClick={() => navigate('/login', { replace: true })}>
            {t('invite.backToLogin')}
          </Button>
        )}
      </div>
    </div>
  )
}
