// We probably don't need the D type parameter, or
// we can constrain it to be Disposable | AsyndDisposable
export interface Stream<A, E, R, D> {
  A: A
  E: E
  R: (r: R) => void
  D: D
  run(env: R, sink: Sink<A, E>): D

  // This might be a nice addition.  Other libs seem to have adopted it
  // and it's a good standin for |>
  pipe<B>(f: (s: Stream<A, E, R, D>) => B): B
}

type U2I<U> =
  (U extends any ? (x: U) => void : never) extends ((x: infer I) => void) ? I : never

type Env<S> = S extends Stream<unknown, unknown, infer R, unknown> ? R : never

export interface Sink<A, E> {
  event(a: A): void
  error(e: E): void
  end(): void
}

// We should investigate how much of a benefit it is for Streams
// to be classes vs something like this (basically @most/core newStream)
// which is super compact and convenient.
// My intuition is that since Stream creation typically won't be the
// bulk of what an application does after it's started, this will be ok
// The same might hold for Sink, but I'm not sure.
// We should test it, though.
export const stream = <A, E, R, D>(run: (env: R, sink: Sink<A, E>) => D): Stream<A, E, R, D> => ({
  run,
  pipe(f) { return f(this) }
}) as Stream<A, E, R, D>

abstract class TransformSink<A, B, E> implements Sink<A, E> {
  constructor(protected readonly sink: Sink<B, E>) { }

  abstract event(a: A): void

  error(e: E) {
    this.sink.error(e)
  }

  end(): void {
    this.sink.end()
  }
}

abstract class MergingSink<A, E> implements Sink<A, E> {
  constructor(public readonly sink: Sink<A, E>, public readonly state: { active: number }, public readonly disposables: readonly Disposable[]) { }

  abstract event(a: A): void

  error(e: E) {
    if (--this.state.active === 0) {
      this.disposables.forEach(d => d[Symbol.dispose]())
      this.sink.error(e)
    }
  }

  end() {
    if (--this.state.active === 0) {
      this.disposables.forEach(d => d[Symbol.dispose]())
      this.sink.end()
    }
  }

}

export const disposeNone = { [Symbol.dispose]: () => undefined }

export const empty: Stream<never, never, {}, Disposable> = stream((_, sink) => {
  sink.end()
  return ({ [Symbol.dispose]: () => undefined })
})

export const never: Stream<never, never, {}, Disposable> = stream(() => ({ [Symbol.dispose]: () => undefined }))

export type Immediate = {
  setImmediate: typeof setImmediate
}

export const now = <A>(a: A) => stream(({ setImmediate }: Immediate, sink: Sink<A, never>) => setImmediate(sink => {
  sink.event(a)
  sink.end()
}, sink))

export type Timeout = {
  setTimeout: typeof setTimeout
}

export const at = <A>(t: number, a: A) =>
  stream(({ setTimeout }: Timeout, sink: Sink<A, never>) => setTimeout(sink => {
    sink.event(a)
    sink.end()
  }, t, sink))

export type Interval = {
  setInterval: typeof setInterval
}

export const periodic = <A>(period: number, a: A) => stream(({ setInterval }: Interval, sink: Sink<A, never>) =>
  setInterval(sink => sink.event(a), period, sink))

export const map = <A, B>(f: (a: A) => B) => <E, R, D>(s: Stream<A, E, R, D>) =>
  stream((env: R, sink: Sink<B, E>) => s.run(env, new MapSink(f, sink)))

class MapSink<A, B, E> extends TransformSink<A, B, E> {
  constructor(public readonly f: (a: A) => B, sink: Sink<B, E>) { super(sink) }

  event(a: A) {
    this.sink.event(this.f(a))
  }
}

export const tap = <A>(f: (a: A) => unknown) => <E, R, D>(s: Stream<A, E, R, D>) =>
  stream((env: R, sink: Sink<A, E>) => s.run(env, new TapSink(f, sink)))

class TapSink<A, E> extends TransformSink<A, A, E> {
  constructor(public readonly f: (a: A) => unknown, sink: Sink<A, E>) { super(sink) }

  event(a: A) {
    this.f(a)
    this.sink.event(a)
  }
}

export function filter<A, B extends A>(f: (a: A) => a is B): <E, R, D>(s: Stream<A, E, R, D>) => Stream<B, E, R, D>
export function filter<A>(f: (a: A) => boolean): <E, R, D>(s: Stream<A, E, R, D>) => Stream<A, E, R, D>
export function filter<A>(f: (a: A) => boolean) {
  return <E, R, D>(s: Stream<A, E, R, D>) =>
    stream((env: R, sink: Sink<any, E>) => s.run(env, new FilterSink(f, sink)))
}

class FilterSink<A, E> extends TransformSink<A, A, E> {
  constructor(public readonly p: (a: A) => boolean, sink: Sink<A, E>) { super(sink) }

  event(a: A) {
    this.p(a) && this.sink.event(a)
  }
}

export const scan = <A, B>(f: (b: B, a: A) => B, b: B) => <E, R, D>(s: Stream<A, E, R, D>): Stream<B, E, R, D> =>
  stream((env: R, sink: Sink<B, E>) => s.run(env, new ScanSink(f, b, sink)))

class ScanSink<A, B, E> extends TransformSink<A, B, E> {
  constructor(public readonly f: (b: B, a: A) => B, private b: B, sink: Sink<B, E>) { super(sink) }

  event(a: A) {
    this.b = this.f(this.b, a)
    this.sink.event(this.b)
  }
}

export const merge = <Streams extends readonly Stream<unknown, unknown, any, Disposable>[]>(...ss: Streams): Stream<Streams[number]['A'], Streams[number]['E'], U2I<Env<Streams[number]>>, Disposable> =>
  stream((env: U2I<Env<Streams[number]>>, sink: Sink<Streams[number]['A'], Streams[number]['E']>) => {
    const state = { active: ss.length }
    // All multi-stream combinators seem like they might benefit from
    // DisposableStack, but I don't have any experience with it yet.
    const disposables = [] as Disposable[]
    disposables.push(...ss.map(s => s.run(env, new MergeSink(sink, state, disposables))))
    return { [Symbol.dispose]: () => disposables.forEach(d => d[Symbol.dispose]()) }
  })

class MergeSink<A, E> extends MergingSink<A, E> {
  constructor(public readonly sink: Sink<A, E>, public readonly state: { active: number }, public readonly disposables: readonly Disposable[]) {
    super(sink, state, disposables)
  }

  event(a: A) {
    this.sink.event(a)
  }
}

// The types are verbose, but work great :)
// FYI: change here to add the initial values
// This simplifies combine drastically by not having to buffer
// until it has at least one value from all streams.
// It's trivial to recover the other behavior using an array of undefines
// and a subsequent filter()
export const combine = <const Streams extends readonly Stream<unknown, unknown, any, Disposable>[]>(
  init: { readonly [K in keyof Streams]: Streams[K]['A'] },
  ...ss: Streams
): Stream<{ readonly [K in keyof Streams]: Streams[K]['A'] }, Streams[number]['E'], U2I<Env<Streams[number]>>, Disposable> =>
  stream((env: U2I<Env<Streams[number]>>, sink: Sink<{ readonly [K in keyof Streams]: Streams[K]['A'] }, Streams[number]['E']>) => {
    const state = { active: ss.length }
    const disposables = [] as Disposable[]
    const values = [...init]
    disposables.push(...ss.map((s, i) => s.run(env, new CombineSink(sink, values, i, state, disposables))))
    return { [Symbol.dispose]: () => disposables.forEach(d => d[Symbol.dispose]()) }
  })

class CombineSink<I extends number, Streams extends readonly Stream<unknown, unknown, any, Disposable>[], E> extends MergingSink<Streams[I]['A'], E> {
  constructor(public readonly sink: Sink<Streams[I]['A'], E>, public values: { [K in keyof Streams]: Streams[K]['A'] }, public readonly index: I, public readonly state: { active: number }, public readonly disposables: readonly Disposable[]) {
    super(sink, state, disposables)
  }

  event(a: Streams[I]['A']) {
    this.values[this.index] = a
    this.sink.event(this.values)
  }
}

export const lswitch = <S extends Stream<Stream<unknown, unknown, any, Disposable>, unknown, any, Disposable>>(s: S): Stream<S['A']['A'], S['E'] | S['A']['E'], U2I<Env<S['A']> | Env<S>>, Disposable> =>
  stream((env: U2I<Env<S['A']> | Env<S>>, sink: Sink<S['A']['A'], S['E'] | S['A']['E']>) => {
    let currentDisposable: Disposable = disposeNone
    let outerEnded = false
    let innerEnded = false
    const d = s.run(env, {
      event: s => {
        currentDisposable[Symbol.dispose]()
        currentDisposable = s.run(env, {
          event: a => sink.event(a),
          error: e => sink.error(e),
          end: () => {
            if (innerEnded) return
            innerEnded = true
            if (outerEnded) sink.end()
          }
        })
      },
      error: e => {
        currentDisposable[Symbol.dispose]()
        outerEnded = true
        sink.error(e)
      },
      end: () => {
        if (outerEnded) return
        outerEnded = true
        if (innerEnded) sink.end()
      }
    })
    return { [Symbol.dispose]() { d[Symbol.dispose](); currentDisposable[Symbol.dispose]() } }
  })

export const continueWith = <E1, A2, E2, R2, D extends Disposable>(f: () => Stream<A2, E2, R2, D>) => <A1, R1>(s: Stream<A1, E1, R1, D>) =>
  stream((env: R1 & R2, s1: Sink<A1 | A2, E1 | E2>) => {
    let d = s.run(env, {
      event: a => s1.event(a),
      error: e => s1.error(e),
      end: () => {
        d[Symbol.dispose]()
        d = f().run(env, s1)
      }
    })
    return {
      [Symbol.dispose]() {
        d[Symbol.dispose]()
      }
    }
  })

// Similar to @most/core runEffects
// Run a stream in the provided environment
export const runStream = <A, E, R>(s: Stream<A, E, R, Disposable>, env: R, sink: Sink<A, E>) => {
  const d = s.run(env, {
    event: e => sink.event(e),
    error(e) {
      // Unclear whether to try/catch this or not
      // Catching the error and sending it to sink.end requires
      // changing the Sink type to Sink<A, unknown>, which is unfortunate
      d[Symbol.dispose]()
      sink.error(e)
    },
    end() {
      // Unclear whether to try/catch this or not
      // Catching the error and sending it to sink.end requires
      // changing the Sink type to Sink<A, unknown>, which is unfortunate
      d[Symbol.dispose]()
      sink.end()
    }
  })

  return d
}

// Similar to @most/core runEffects
// Run a stream in the provided environment, return a promise for its end
export const runPromise = <A, E, R>(s: Stream<A, E, R, Disposable>, env: R) =>
  new Promise<void>((resolve, reject) =>
    runStream(s, env, {
      event() { },
      error: e => reject(e),
      end: resolve
    })
  )

// const p1 = periodic(1000, 0).pipe(map(() => Math.random()))
// const p2 = periodic(2500, 0).pipe(map(() => Date.now()))
// const p3 = now(1)

// const s = combine([0, 0, 1], p1, p2, p3)
// const s = merge(p1, p2, p3)

// runStream(s, { setInterval, setImmediate }, {
//   event: console.log,
//   error: console.error,
//   end: () => console.log('done')
// })
