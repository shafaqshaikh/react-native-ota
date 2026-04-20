import { NativeModules } from 'react-native';

const { OTAUpdatesModule } = NativeModules;

if (!OTAUpdatesModule) {
  throw new Error(
    '[react-native-ota-updates] Native module not linked. ' +
    'If using Expo, add "react-native-ota-updates" to your plugins in app.config.js and run expo prebuild.'
  );
}

export interface NativeDirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

/** Document directory path from native side */
export const documentDirectory: string =
  OTAUpdatesModule.documentDirectory ||
  OTAUpdatesModule.getConstants?.().documentDirectory ||
  '';

export const Native = {
  setNextBundlePath: (path: string): Promise<boolean> =>
    OTAUpdatesModule.setNextBundlePath(path),

  clearBundlePath: (): Promise<boolean> =>
    OTAUpdatesModule.clearBundlePath(),

  confirmLaunchSuccess: (): Promise<boolean> =>
    OTAUpdatesModule.confirmLaunchSuccess(),

  mkdir: (path: string): Promise<boolean> =>
    OTAUpdatesModule.mkdir(path),

  exists: (path: string): Promise<boolean> =>
    OTAUpdatesModule.exists(path),

  readFile: (path: string, encoding = 'utf8'): Promise<string> =>
    OTAUpdatesModule.readFile(path, encoding),

  writeFile: (path: string, content: string, encoding = 'utf8'): Promise<boolean> =>
    OTAUpdatesModule.writeFile(path, content, encoding),

  moveFile: (src: string, dest: string): Promise<boolean> =>
    OTAUpdatesModule.moveFile(src, dest),

  deleteFile: (path: string): Promise<boolean> =>
    OTAUpdatesModule.deleteFile(path),

  readDir: (path: string): Promise<NativeDirEntry[]> =>
    OTAUpdatesModule.readDir(path),

  sha256File: (path: string): Promise<string> =>
    OTAUpdatesModule.sha256File(path),
};
