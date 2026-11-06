import { ApkPlugin } from './apkPlugin';

interface NativeStatePlugin {
  stateRead(): Promise<{ exists: boolean; value?: string }>;
  stateWrite(options: { value: string }): Promise<{ ok: boolean; bytes: number }>;
}

const plugin = ApkPlugin as unknown as NativeStatePlugin;

/** Независимая копия внутри filesDir приложения. Переживает обновление APK поверх. */
export async function readNativeStateFile(): Promise<string | null> {
  const result = await plugin.stateRead();
  return result.exists && result.value ? result.value : null;
}

export async function writeNativeStateFile(value: string): Promise<void> {
  await plugin.stateWrite({ value });
}
