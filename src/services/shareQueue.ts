/**
 * shareQueue.ts — 分享面板接收的待导入文件队列（模块级单例）
 *
 * ACTION_SEND 的文件流不经 RN Linking（那是 VIEW/data 的事），由
 * expo-share-intent 的 ShareIntentProvider 捕获；根布局收到后入队并跳导入页，
 * 导入页挂载时取走。轻量模块级变量而非全局 state——跳转间隔内不丢失即可。
 */

interface PendingShare {
  uri: string; // file:// URI（包已把分享文件拷到 app 缓存目录）
  fileName: string;
}

let pending: PendingShare | null = null;

/** 根布局收到分享文件时入队（新文件覆盖旧的——系统分享面板一次一份） */
export function queueShareFile(uri: string, fileName: string): void {
  pending = { uri, fileName };
}

/** 导入页挂载时取走（一次性消费）；无待处理返回 null */
export function takeShareFile(): PendingShare | null {
  const p = pending;
  pending = null;
  return p;
}
