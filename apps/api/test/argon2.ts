// Pure helper, deliberately free of database imports so unit tests can use it.

/** Decodes argon2's PHC string ($argon2id$v=19$m=..,t=..,p=..$salt$hash). */
export function argon2Params(hash: string): { algorithm: string; m: number; t: number; p: number } {
  const [, algorithm = '', , params = ''] = hash.split('$');
  const values = new Map<string, number>(
    params.split(',').map((kv): [string, number] => {
      const [key = '', value = ''] = kv.split('=');
      return [key, Number(value)];
    }),
  );
  return {
    algorithm,
    m: values.get('m') ?? NaN,
    t: values.get('t') ?? NaN,
    p: values.get('p') ?? NaN,
  };
}
