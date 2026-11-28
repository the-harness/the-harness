export async function* single<T>(item: T): AsyncIterable<T> {
  yield item;
}

export async function* empty<T>(): AsyncIterable<T> {}
