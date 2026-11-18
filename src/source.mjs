import { readFile } from 'node:fs/promises';

// 来源文件是一个采集批次：{ source, observedAt, pages: [...] }。
// 每个 page 是某个门户的一次抓取结果：明细页、仅总状态页，或失败页（带 error）。
export async function readSource(path = new URL('../data/source.json', import.meta.url)) {
  const text = await readFile(path, 'utf8');
  const batch = JSON.parse(text);
  if (!batch || typeof batch !== 'object' || !batch.source || !Array.isArray(batch.pages)) {
    throw new Error('来源批次缺少 source 或 pages');
  }
  return batch;
}
