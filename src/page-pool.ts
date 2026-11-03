import { chromium, type BrowserContext } from 'playwright';
import { EventEmitter } from 'events';
import { type PageWorker } from './types.js';

export interface PagePoolOptions {
  userDataDir: string;
  headless: boolean;
  poolSize: number;
  initialUrl: string;
}

export class PagePool {
  private workers: PageWorker[] = [];
  private waitingQueue: Array<(worker: PageWorker) => void> = [];
  private context: BrowserContext | null = null;
  private readonly options: PagePoolOptions;

  constructor(options: PagePoolOptions) {
    this.options = options;
  }

  async init(): Promise<void> {
    console.log('Launching Chromium sandbox environment...');
    this.context = await chromium.launchPersistentContext(this.options.userDataDir, {
      headless: this.options.headless,
      channel: 'chrome',
      viewport: { width: 1280, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--mute-audio',
        '--disable-notifications',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });

    await this.context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) return route.abort();
      return route.continue();
    });

    const initialPages = this.context.pages();
    if (initialPages.length > 0) {
      await Promise.all(initialPages.map((p) => p.close().catch(() => {})));
    }

    console.log(`Creating tab resource pool, capacity: ${this.options.poolSize}...`);
    for (let i = 0; i < this.options.poolSize; i++) {
      const page = await this.context.newPage();
      const emitter = new EventEmitter();

      await page.exposeFunction('__pushChunk', (delta: string) => {
        emitter.emit('chunk', delta);
      });
      await page.exposeFunction('__pushDone', () => {
        emitter.emit('done');
      });

      console.log(`[Worker #${i + 1}] Warming up entry point: ${this.options.initialUrl}`);
      await page.goto(this.options.initialUrl, { waitUntil: 'domcontentloaded' });

      this.workers.push({
        id: i + 1,
        page,
        busy: false,
        emitter,
      });
    }

    console.log('Resource pool initialized. All tabs are ready.');
  }

  async acquire(): Promise<PageWorker> {
    const idleWorker = this.workers.find((w) => !w.busy);
    if (idleWorker) {
      idleWorker.busy = true;
      return idleWorker;
    }

    return new Promise<PageWorker>((resolve) => {
      this.waitingQueue.push((worker) => {
        worker.busy = true;
        resolve(worker);
      });
    });
  }

  release(worker: PageWorker) {
    worker.emitter.removeAllListeners();
    worker.busy = false;

    if (this.waitingQueue.length > 0) {
      const nextResolve = this.waitingQueue.shift();
      if (nextResolve) {
        nextResolve(worker);
      }
    }
  }
}