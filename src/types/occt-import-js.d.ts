// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module 'occt-import-js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export default function init(options?: { locateFile?: (path: string) => string }): Promise<any>
}
