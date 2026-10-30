const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const fmt = (args: any[]) => args.map(a => a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a)).join(' ')

export const log = {
  info: (...a: any[]) => console.log(`${ts()} INFO  ${fmt(a)}`),
  warn: (...a: any[]) => console.warn(`${ts()} WARN  ${fmt(a)}`),
  error: (...a: any[]) => console.error(`${ts()} ERROR ${fmt(a)}`),
  debug: (...a: any[]) => { if (process.env.LOGSHIP_AGENT_DEBUG) console.log(`${ts()} DEBUG ${fmt(a)}`) }
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
