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

export interface Sink<A, E> {
  event(a: A): void
  end(e?: E): void
}

// We should investigate how much of a benefit it is for Streams
// to be classes vs something like this (basically @most/core newStream)
// which is super compact and convenient.
// My intuition is that since Stream creation typically won't be the
// bulk of what an application does after it's started, this will be ok
// The same might hold for Sink, but I'm not sure.
// We should test it, though.
const stream = <A, E, R, D>(run: (env: R, sink: Sink<A, E>) => D): Stream<A, E, R, D> => ({
  run,
  pipe(f) { return f(this) }
}) as Stream<A, E, R, D>

abstract class TransformSink<A, B, E> implements Sink<A, E> {
  constructor(protected readonly sink: Sink<B, E>) { }

  abstract event(a: A): void

  end(e?: E): void {
    this.sink.end(e)
  }
}

export const disposeNone = { [Symbol.dispose]: () => undefined }

export const empty: Stream<never, never, unknown, Disposable> = stream((_, sink) => {
  sink.end()
  return ({ [Symbol.dispose]: () => undefined })
})

export const never: Stream<never, never, unknown, Disposable> = stream(() => ({ [Symbol.dispose]: () => undefined }))

export type Timeout = {
  setTimeout<Args extends readonly any[]>(f: (...a: Args) => void, timeoutMillis: number, ...a: Args): Disposable
}

export const at = (t: number) =>
  stream(({ setTimeout }: Timeout, sink: Sink<undefined, never>) => setTimeout(sink => {
    sink.event(undefined)
    sink.end()
  }, t, sink))

export const periodic = (period: number): Stream<undefined, never, Timeout, Disposable> =>
  at(period).pipe(continueWith(() => periodic(period)))

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

type U2I<U> =
  (U extends any ? (x: U) => void : never) extends ((x: infer I) => void) ? I : never

export const merge = <Streams extends readonly Stream<unknown, unknown, any, Disposable>[]>(...ss: Streams): Stream<Streams[number]['A'], Streams[number]['E'], U2I<Parameters<Streams[number]['R']>[0]>, Disposable> =>
  stream((env: U2I<Streams[number]['R']>, sink: Sink<Streams[number]['A'], Streams[number]['E']>) => {
    const state = { active: ss.length }
    // All multi-stream combinators seem like they might benefit from
    // DisposableStack, but I don't have any experience with it yet.
    const disposables = [] as Disposable[]
    disposables.push(...ss.map(s => s.run(env, new MergeSink(sink, state, disposables))))
    return { [Symbol.dispose]: () => disposables.forEach(d => d[Symbol.dispose]()) }
  })

class MergeSink<A, E> implements Sink<A, E> {
  constructor(private readonly sink: Sink<A, E>, private readonly state: { active: number }, private readonly disposables: readonly Disposable[]) { }

  event(a: A) {
    this.sink.event(a)
  }

  end(e?: E) {
    if (e !== undefined || --this.state.active === 0) {
      this.disposables.forEach(d => d[Symbol.dispose]())
      this.sink.end(e)
    }
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
): Stream<{ readonly [K in keyof Streams]: Streams[K]['A'] }, Streams[number]['E'], U2I<Parameters<Streams[number]['R']>[0]>, Disposable> =>
  stream((env: U2I<Streams[number]['R']>, sink: Sink<{ readonly [K in keyof Streams]: Streams[K]['A'] }, Streams[number]['E']>) => {
    const state = { active: ss.length }
    const disposables = [] as Disposable[]
    const values = [...init]
    disposables.push(...ss.map((s, i) => s.run(env, new CombineSink(sink, values, i, state, disposables))))
    return { [Symbol.dispose]: () => disposables.forEach(d => d[Symbol.dispose]()) }
  })

class CombineSink<I extends number, Streams extends readonly Stream<unknown, unknown, any, Disposable>[], E> implements Sink<Streams[I]['A'], E> {
  constructor(private readonly sink: Sink<Streams[I]['A'], E>, private values: { [K in keyof Streams]: Streams[K]['A'] }, private readonly index: I, private readonly state: { active: number }, private readonly disposables: readonly Disposable[]) { }

  event(a: Streams[I]['A']) {
    this.values[this.index] = a
    this.sink.event(this.values)
  }

  end(e?: E) {
    if (e !== undefined || --this.state.active === 0) {
      this.disposables.forEach(d => d[Symbol.dispose]())
      this.sink.end(e)
    }
  }
}

const continueWith = <E1, A2, E2, R2, D extends Disposable>(f: (e?: E1) => Stream<A2, E2, R2, D>) => <A1, R1>(s: Stream<A1, E1, R1, D>) =>
  stream((env: R1 & R2, s1: Sink<A1 | A2, E1 | E2>) => {
    const s0 = new ContinueWithSink(env, f, s1)
    const d = s.run(env, s0)
    return {
      [Symbol.dispose]() {
        d[Symbol.dispose]()
        s0.d[Symbol.dispose]()
      }
    }
  })

class ContinueWithSink<A1, E1, R1, A2, E2, R2> implements Sink<A1, E1> {
  public d: Disposable = disposeNone

  constructor(private readonly env: R1 & R2, private readonly f: (e?: E1) => Stream<A2, E2, R2, Disposable>, private readonly sink: Sink<A1 | A2, E1 | E2>) { }

  event(a: A1) {
    this.sink.event(a)
  }

  end(e?: E1) {
    this.d = this.f(e).run(this.env, this.sink)
  }
}

// Similar to @most/core runEffects
// Run a stream in the provided environment
export const runStream = <A, E, R>(s: Stream<A, E, R, Disposable>, env: R, sink: Sink<A, E>) => {
  const d = s.run(env, {
    event: e => sink.event(e),
    end: e => {
      // Unclear whether to try/catch this or not
      // Catching the error and sending it to sink.end requires
      // changing the Sink type to Sink<A, unknown>, which is unfortunate
      d[Symbol.dispose]()
      sink.end(e)
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
      end: e => e ? reject(e) : resolve()
    })
  )

const p1 = periodic(1000).pipe(map(() => Date.now()))
const p2 = periodic(2500).pipe(map(() => new Date().toISOString()))

const s = combine([0, ''], p1, p2)

runStream(s, { setTimeout }, {
  event: console.log,
  end: e => e ? console.error(e) : console.log('done')
})
