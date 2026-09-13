import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { BrandMark } from '@/components/brand-mark.js'
import { LanguageSwitcher } from '@/components/language-switcher.js'
import { ThemeSwitcher } from '@/components/theme-switcher.js'
import { Alert, AlertDescription } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent } from '@/components/ui/card.js'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import { ApiError, submitSetup } from '../lib/api.js'

/**
 * 装机引导：**平台还没配域名时唯一能用的界面**。
 *
 * 装机没给 `--domain`，安装脚本会把 `http://<ip>/setup?token=…` 打印出来。那枚 token 是
 * **一次性**凭证（服务端拿它换域名）；填完域名之后服务端落库 → **立刻摘掉 :80 上的明文
 * 引导口** → 重启自己换身份。所以这里最后说的是「稍后去 `console.<域>` 登录」，不是「已就绪」。
 */
export default function SetupPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [baseDomain, setBaseDomain] = useState('')
  const { t } = useTranslation()

  const mutation = useMutation({
    mutationFn: () => submitSetup(token, baseDomain),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    mutation.mutate()
  }

  if (mutation.isSuccess) {
    const { consoleDomain, dns } = mutation.data
    return (
      <Shell>
        <Card>
          <CardContent className="flex flex-col gap-4">
            <h2 className="font-heading text-base font-semibold">{t('setup.doneTitle')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('setup.doneBody', { domain: consoleDomain })}
            </p>
            {!dns.resolved && (
              <Alert>
                <AlertDescription>{t('setup.doneDns', { probe: dns.probe })}</AlertDescription>
              </Alert>
            )}
            <p className="text-sm text-muted-foreground">{t('setup.doneClose')}</p>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell>
      <Card>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t('setup.intro')}</p>

            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="baseDomain">{t('setup.domain')}</FieldLabel>
                <Input
                  id="baseDomain"
                  required
                  value={baseDomain}
                  onChange={(e) => setBaseDomain(e.target.value)}
                  placeholder="example.com"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <FieldDescription>{t('setup.domainHint')}</FieldDescription>
              </Field>
            </FieldGroup>

            {token === '' && (
              <Alert variant="destructive">
                <AlertDescription>{t('setup.noToken')}</AlertDescription>
              </Alert>
            )}

            {mutation.isError && (
              <Alert variant="destructive">
                <AlertDescription>{errorText(mutation.error, t)}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={mutation.isPending || token === ''}>
              {mutation.isPending ? t('setup.pending') : t('setup.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </Shell>
  )
}

/** 登录页那套外壳：品牌 + 语言/主题切换，内容居中。 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-full items-center justify-center p-6">
      <div className="absolute top-4 right-4 flex items-center gap-1">
        <LanguageSwitcher />
        <ThemeSwitcher />
      </div>
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3">
          <BrandMark className="size-12" />
          <h1 className="font-heading text-xl font-semibold">
            dsh-<span className="text-muted-foreground">cloud</span>
          </h1>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * 服务端只回状态码（它不知道 UI 用什么语言），文案在这一层翻。
 * 三个码各说一件事：凭证不对 / 已经配过了 / 域名写法不对。
 */
function errorText(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return t('setup.errToken')
    if (error.status === 409) return t('setup.errConfigured')
    if (error.status === 400) return t('setup.errDomain')
  }
  return t('common.requestFailed')
}
