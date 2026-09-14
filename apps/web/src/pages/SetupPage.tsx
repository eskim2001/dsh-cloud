import { useMutation } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
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
import { ApiError, probeSetupDomain, submitSetup } from '../lib/api.js'

/**
 * 装机引导：**平台还没配域名时唯一能用的界面**。
 *
 * 这一步是**危险的**：域名一旦提交就落库，控制面带着它重启，会话 cookie 和 better-auth 的
 * baseURL 都按它定死。解析配错 = 控制台进不去，只能上 SSH 救。所以这一页的重点不是"解释清楚"，
 * 而是**让人在按下按钮之前就看见结果**：
 *
 * - 边打字边查泛解析（`/api/setup/probe`），没通就不让提交（要硬来可以，但得显式点一下）
 * - 要加的 DNS 记录**直接算好列出来**，带这台机器的地址，不用人去理解"泛解析"
 * - 出错贴到出错的那个字段上，不说教
 */
export default function SetupPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [typedDomain, setTypedDomain] = useState('')
  const [override, setOverride] = useState(false)
  const { t } = useTranslation()

  // 走 IP 进来时才知道该把记录指向哪；用域名/内网名进来的，DNS 多半已经通了
  const host = window.location.hostname
  const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)

  // 从地址栏粘过来的是 `https://console.example.com/`，人也会打成大写 —— 先归一化再判断
  const domain = typedDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/[/?#].*/u, '')
    .replace(/\.$/u, '')
  const shapeOk = /^[a-z0-9.-]+$/u.test(domain) && domain.includes('.')

  const probe = useDomainProbe(token, domain, shapeOk)
  const mutation = useMutation({
    mutationFn: () => submitSetup({ token, baseDomain: domain, email, password }),
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
          <CardContent className="flex flex-col gap-3">
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

  const error = mutation.error
  const code = error instanceof ApiError ? error.message : ''
  const blocked = probe === 'missing' && !override

  return (
    <Shell>
      <Card>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <h2 className="font-heading text-base font-semibold">{t('setup.title')}</h2>

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
                  value={typedDomain}
                  onChange={(e) => setTypedDomain(e.target.value)}
                  placeholder="example.com"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  // 拼错会让控制台落到别的主机名上，而这一页事后就进不来了
                  aria-invalid={probe === 'missing'}
                />
                <DomainStatus probe={probe} domain={domain} host={host} isIp={isIp} />
                {isIp && domain !== host && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="self-start"
                    onClick={() => setTypedDomain(`${host}.sslip.io`)}
                  >
                    {t('setup.useTempDomain')}
                  </Button>
                )}
              </Field>
            </FieldGroup>

            {error !== undefined && (
              <Alert variant="destructive">
                <AlertDescription>{errorText(error, t)}</AlertDescription>
              </Alert>
            )}

            {blocked && (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="self-start"
                onClick={() => setOverride(true)}
              >
                {t('setup.dnsOverride')}
              </Button>
            )}

            <Button type="submit" disabled={mutation.isPending || token === '' || !shapeOk || blocked}>
              {mutation.isPending ? t('setup.pending') : t('setup.submit')}
            </Button>

            <p className="text-xs text-muted-foreground">{t('setup.insecure')}</p>
          </form>
        </CardContent>
      </Card>
    </Shell>
  )
}

type Probe = 'idle' | 'checking' | 'ok' | 'missing'

/** 边打字边查泛解析。停手 450ms 再发，别把人家的 DNS 打爆。 */
function useDomainProbe(token: string, domain: string, shapeOk: boolean): Probe {
  const [state, setState] = useState<Probe>('idle')

  useEffect(() => {
    if (token === '' || !shapeOk) {
      setState('idle')
      return
    }
    setState('checking')
    let alive = true
    const timer = setTimeout(() => {
      probeSetupDomain(token, domain)
        .then((r) => {
          if (alive) setState(r.resolved ? 'ok' : 'missing')
        })
        .catch(() => {
          if (alive) setState('idle')
        })
    }, 450)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [token, domain, shapeOk])

  return state
}

/**
 * 域名那一格下面的**实时状态**。没通的时候直接把要加的记录列出来 —— 带着这台机器的地址，
 * 让人复制粘贴就行，而不是去理解"泛解析"是什么意思。
 */
function DomainStatus(props: {
  probe: Probe
  domain: string
  host: string
  isIp: boolean
}): ReactNode {
  const { t } = useTranslation()
  if (props.probe === 'idle') return null

  if (props.probe === 'checking') {
    return <FieldDescription>{t('setup.dnsChecking')}</FieldDescription>
  }

  if (props.probe === 'ok') {
    return <FieldDescription>{t('setup.dnsOk', { domain: `console.${props.domain}` })}</FieldDescription>
  }

  return (
    <div className="flex flex-col gap-2">
      <FieldDescription>{t('setup.dnsMissing')}</FieldDescription>
      <div className="rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-[11px] leading-5">
        <div>{`console.${props.domain}`}</div>
        <div>{`*.${props.domain}`}</div>
      </div>
      {props.isIp && (
        <FieldDescription>{t('setup.dnsPointTo', { host: props.host })}</FieldDescription>
      )}
    </div>
  )
}

/** 登录页那套外壳：品牌 + 语言/主题切换，内容居中。 */
function Shell({ children }: { children: ReactNode }) {
  return (
    // 内容比视口高时**必须能滚**：`items-center` 会把超出的部分顶到容器外，那截就再也滚不回来，
    // 按钮会够不着。改成「容器滚 + 子元素 my-auto 居中」——装得下就居中，装不下就从顶上滚。
    <div className="relative flex h-full justify-center overflow-y-auto p-6">
      <div className="absolute top-4 right-4 flex items-center gap-1">
        <LanguageSwitcher />
        <ThemeSwitcher />
      </div>
      <div className="my-auto flex w-full max-w-sm flex-col gap-6">
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
 * 服务端只回状态码和机器可读的 `error`，文案在这一层翻。**说清哪儿错了**，别夹带设计理由。
 * 409 和 400 各有两个含义，靠 `error` 字段区分（它落在 `ApiError.message` 上，见 api.ts）。
 */
function errorText(error: unknown, t: TFunction): string {
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
