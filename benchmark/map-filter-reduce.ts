import { Bench } from 'tinybench'
import { Immediate, Sink, filter, map, runPromise, scan, stream, tap } from '../src'
import * as Rx from 'rxjs'

const bench = new Bench({ time: 100 })

const n = 5

const arr = Array.from({ length: Math.pow(10, n) }, (_, i) => i)

const add1 = (x: number) => x + 1
const even = (x: number) => (x % 2) === 0
const sum = (x: number, y: number) => x + y

const fromArray = <A>(arr: readonly A[]) => stream(({ setImmediate }: Immediate, sink: Sink<A, never>) =>
  setImmediate(sink => {
    for (const a of arr) sink.event(a)
    sink.end()
  }, sink))

bench
  .add(`rx7 map-filter-reduce 1e${n}`, () => {
    return Rx.lastValueFrom(Rx.from(arr).pipe(Rx.map(add1)).pipe(Rx.filter(even)).pipe(Rx.reduce(sum, 0)))
  })
  .add(`mc2 map-filter-reduce 1e${n}`, () => {
    let r = 0
    const s = fromArray(arr).pipe(map(add1)).pipe(filter(even)).pipe(scan(sum, 0)).pipe(tap(x => r = x))
    return runPromise(s, { setImmediate }).then(() => r)
  })

await bench.warmup()
await bench.run()

console.table(bench.table())
