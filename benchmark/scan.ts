import { Bench } from 'tinybench'
import { Immediate, Sink, pipe, runPromise, scan, stream, tap } from '../src'
import * as Rx from 'rxjs'
import * as MC from '@most/core'
import * as MS from '@most/scheduler'

const bench = new Bench({ time: 100 })

const n = 1000000

const arr = Array.from({ length: n }, (_, i) => i)

const sum = (x: number, y: number) => {
  // console.log(x, y)
  return x + y
}

const fromArray = <A>(arr: readonly A[]) => stream(({ setImmediate }: Immediate, sink: Sink<A, never>) =>
  setImmediate(sink => {
    for (const a of arr) sink.event(a)
    sink.end()
  }, sink))

const fromArrayM = <A>(arr: readonly A[]) => MC.newStream<A>((sink, s) =>
  MS.asap({
    run(t) {
      for (const a of arr) sink.event(t, a)
      sink.end(t)
    },
    error(t, e) {
      sink.error(t, e)
    },
    dispose() { }
  }, s))

bench
  .add(`rx7 scan ${n}`, () => {
    return Rx.lastValueFrom(Rx.from(arr).pipe(Rx.scan(sum, 0)))
  })
  .add(`mc1 scan ${n}`, () => {
    let r = 0
    const s0 = MC.scan(sum, 0, fromArrayM(arr))
    const s = MC.tap((x => r = x), s0)
    return MC.runEffects(s, MS.newDefaultScheduler()).then(() => r)
  })
  .add(`mc2 scan ${n}`, () => {
    let r = 0
    return pipe(fromArray(arr), scan(sum, 0), tap(x => r = x), runPromise({ setImmediate })).then(() => r)
  })

await bench.warmup()
await bench.run()

console.table(bench.table())
