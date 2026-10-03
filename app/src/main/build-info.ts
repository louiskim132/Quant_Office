/** Release identity stamped by scripts/build.mjs; empty in unbuilt (test/dev) runs. */
declare const __QRO_COMMIT__: string | undefined;
declare const __QRO_RELEASED_AT__: string | undefined;

export const BUILD_INFO = {
  commit: typeof __QRO_COMMIT__ === 'string' ? __QRO_COMMIT__ : '',
  releasedAt: typeof __QRO_RELEASED_AT__ === 'string' ? __QRO_RELEASED_AT__ : '',
};
