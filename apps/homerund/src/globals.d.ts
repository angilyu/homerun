declare module "*.sql" {
  const text: string;
  export default text;
}

/** Defined at compile time for release builds (`bun build --define`). */
declare const HOMERUND_VERSION: string | undefined;
declare const HOMERUND_BUILD: string | undefined;
