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
 * 装机没给 `--domain`，安装脚本会把 `http://<机器>:<端口>/setup?token=…` 打印出来。那枚 token 是
 * **一次性**凭证。在这里一次把两件事做完：建首个管理员账号、配父域。提交后服务端建号 → 落库 →
 * **立刻摘掉引导口** → 重启自己换身份。
 *
 * 所以完成页说的是「账号建好了，等证书签好去 `console.<域>` 登录」，**不是**「已就绪」：
 * 证书是 ACME 现签的，DNS 没生效时那个域名这会儿还打不开。
 */
export default function SetupPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [baseDomain, setBaseDomain] = useState('')
  const { t } = useTranslation()

  const mutation = useMutation({
    mutationFn: () => submitSetup({ token, baseDomain, email, password }),
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
              {t('setup.doneBody', { domain: consoleDomain, email: mutation.data.email })}
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
                <FieldLabel htmlFor="email">{t('setup.email')}</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="password">{t('setup.password')}</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
                <FieldDescription>{t('setup.passwordHint')}</FieldDescription>
              </Field>

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

            {/* 这一刻还没有证书，这个页面是明文 HTTP —— 界面有义务说出来，别让人以为在安全通道上 */}
            <p className="text-xs text-muted-foreground">{t('setup.plaintext')}</p>

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
 * 服务端只回状态码和机器可读的 `error`（它不知道 UI 用什么语言），文案在这一层翻。
 * 409 和 400 各有两个含义，靠 `error` 字段区分 —— 它落在 `ApiError.message` 上
 * （`request` 把 body 的 `error` 当消息，见 api.ts）。
 */
function errorText(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return t('setup.errToken')
    if (error.status === 409) {
      return error.message === 'account-exists' ? t('setup.errAccountExists') : t('setup.errConfigured')
    }
    if (error.status === 400) {
      return error.message === 'invalid-account' ? t('setup.errAccount') : t('setup.errDomain')
    }
  }
  return t('common.requestFailed')
}
