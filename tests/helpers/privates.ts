/**
 * The public surface of `T` plus private members a test reaches directly.
 *
 * `interface X extends Class { privateMember(): void }` is rejected outright,
 * and `Class & { privateMember(): void }` collapses to `never`, because the
 * class already declares that member as private. `Omit` maps over public keys
 * only, so it drops the private declarations and leaves a shape the private
 * members can be added to.
 *
 * Tests using this are coupled to internals by design (branch coverage of
 * helpers that are awkward to reach through the public API); prefer the public
 * API where it can express the case.
 */
export type WithPrivates<T, Privates> = Omit<T, keyof Privates> & Privates;
