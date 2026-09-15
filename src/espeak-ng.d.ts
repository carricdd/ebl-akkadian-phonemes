/** Minimal ambient declaration for the GPL espeak-ng WASM package (no types shipped). */
declare module 'espeak-ng' {
  interface ESpeakModule {
    FS: {
      readFile(path: string, opts?: { encoding: 'utf8' }): Uint8Array | string;
      writeFile(path: string, data: Uint8Array | string): void;
      unlink(path: string): void;
    };
  }
  interface ESpeakArgs {
    arguments: string[];
    print?: (line: string) => void;
    printErr?: (line: string) => void;
  }
  export default function ESpeakNG(args: ESpeakArgs): Promise<ESpeakModule>;
}
