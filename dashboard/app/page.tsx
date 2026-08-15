import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  type DailyReview,
  type DashboardSnapshot,
  type VoiceRecord,
  loadDashboardSnapshot,
} from "./dashboard-data";

export const dynamic = "force-dynamic";

const pageTitle = "声笺 · M5 StickS3 语音收件箱";
const pageDescription = "查看 M5 StickS3 的录音、转写、日报与周报。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host");
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProtocol === "http" ? "http" : "https";
  const imageUrl = host ? `${protocol}://${host}/og.png` : undefined;

  return {
    title: { absolute: pageTitle },
    description: pageDescription,
    openGraph: {
      title: pageTitle,
      description: pageDescription,
      type: "website",
      images: imageUrl
        ? [{ url: imageUrl, width: 1731, height: 909, alt: "声笺" }]
        : [],
    },
    twitter: {
      card: "summary_large_image",
      title: pageTitle,
      description: pageDescription,
      images: imageUrl ? [imageUrl] : [],
    },
  };
}

const shanghaiDateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const shanghaiDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "long",
  day: "numeric",
  weekday: "short",
});

const typeLabels: Record<string, string> = {
  idea: "灵感",
  activity: "活动",
  task: "任务",
  note: "笔记",
  journal: "日记",
  pomodoro: "番茄",
  inbox: "收件箱",
};

const statusLabels: Record<string, string> = {
  uploaded: "已上传",
  transcribing: "转写中",
  classifying: "整理中",
  processed: "已完成",
  notion_sync_pending: "待同步",
  synced: "已同步",
  transcription_failed: "转写失败",
  classification_failed: "整理失败",
  generated: "已生成",
  generating: "生成中",
  pending: "等待中",
  failed: "失败",
};

function safeDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value: string | null | undefined): string {
  const date = safeDate(value);
  return date ? shanghaiDateTime.format(date) : "时间未知";
}

function formatReviewDate(value: string): string {
  const date = safeDate(`${value}T12:00:00+08:00`);
  return date ? shanghaiDate.format(date) : value;
}

function recordTitle(record: VoiceRecord): string {
  return record.title?.trim() ||
    record.clean_text?.trim() ||
    record.raw_text?.trim() ||
    "等待转写的录音";
}

function transcript(record: VoiceRecord): string {
  return record.clean_text?.trim() ||
    record.raw_text?.trim() ||
    "录音已经收到，文字仍在处理中。";
}

function durationLabel(seconds: number | null): string {
  if (seconds === null) return "时长未知";
  if (seconds < 60) return `${seconds.toFixed(seconds % 1 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes} 分 ${remainder} 秒`;
}

function statusTone(status: string): string {
  if (status.includes("failed")) return "status status-error";
  if (status === "processed" || status === "generated" || status === "synced") {
    return "status status-success";
  }
  return "status status-progress";
}

function latestGeneratedReview(
  reviews: DailyReview[],
): DailyReview | undefined {
  return reviews.find((review) =>
    review.status === "generated" || review.status === "synced"
  );
}

function recordsToday(snapshot: DashboardSnapshot): number {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return snapshot.records.filter((record) => {
    const date = safeDate(record.captured_at ?? record.received_at);
    if (!date) return false;
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date) === today;
  }).length;
}

function RecordCard({ record }: { record: VoiceRecord }) {
  return (
    <article className="record-card">
      <div className="record-card-top">
        <div className="record-meta">
          <span className="record-type">
            {typeLabels[record.record_type ?? ""] ?? "语音"}
          </span>
          <span>{formatDateTime(record.captured_at ?? record.received_at)}</span>
          <span>{durationLabel(record.audio_duration_seconds)}</span>
        </div>
        <span className={statusTone(record.status)}>
          {statusLabels[record.status] ?? record.status}
        </span>
      </div>
      <h3>{recordTitle(record)}</h3>
      <p className="transcript">{transcript(record)}</p>
      <div className="record-footer">
        {record.audio_url
          ? (
            <audio controls preload="none" src={record.audio_url}>
              你的浏览器不支持音频播放。
            </audio>
          )
          : <span className="audio-unavailable">暂无可播放音频</span>}
        {record.project && <span className="project-chip">{record.project}</span>}
      </div>
    </article>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export default async function Home() {
  const result = await loadDashboardSnapshot();
  const snapshot = result.snapshot;
  const latestDaily = latestGeneratedReview(snapshot.daily_reviews);
  const latestWeekly = snapshot.weekly_reviews.find((review) =>
    review.status === "generated" || review.status === "synced"
  );
  const device = snapshot.devices[0];
  const processedCount = snapshot.records.filter((record) =>
    record.status === "processed" || record.status === "synced"
  ).length;

  return (
    <main>
      <header className="hero">
        <nav className="topbar" aria-label="页面导航">
          <a className="brand" href="#top" aria-label="声笺首页">
            <span className="brand-mark">声</span>
            <span>声笺</span>
          </a>
          <div className="nav-links">
            <a href="#records">录音</a>
            <a href="#daily">日报</a>
            <a href="#weekly">周报</a>
          </div>
        </nav>

        <section className="hero-content" id="top">
          <div>
            <p className="eyebrow">M5 STICKS3 · VOICE INBOX</p>
            <h1>把转瞬即逝的想法，<br />留成可以回看的声笺。</h1>
            <p className="hero-copy">
              录音从设备安全抵达云端，自动完成转写、整理与回顾。
              这里是你的私人查看入口。
            </p>
          </div>
          <div className="device-card">
            <div className="device-orbit" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="device-status-line">
              <span className={device?.enabled ? "live-dot" : "live-dot muted"} />
              {device?.enabled ? "设备已启用" : "等待设备"}
            </div>
            <strong>{device?.id ?? "demo-device-001"}</strong>
            <dl>
              <div>
                <dt>固件</dt>
                <dd>{device?.firmware_version ?? "0.8.0-pomodoro-ui"}</dd>
              </div>
              <div>
                <dt>最后联系</dt>
                <dd>{formatDateTime(device?.last_seen_at)}</dd>
              </div>
            </dl>
          </div>
        </section>

        {result.preview && (
          <div className="preview-banner">
            当前为本地预览数据；部署后将连接你的正式语音收件箱。
          </div>
        )}
        {result.error && (
          <div className="error-banner">
            <strong>数据暂时没有连上。</strong>
            <span>{result.error}</span>
          </div>
        )}
      </header>

      <section className="stats" aria-label="概览">
        <article>
          <span>今日声笺</span>
          <strong>{recordsToday(snapshot).toString().padStart(2, "0")}</strong>
          <small>条新录音</small>
        </article>
        <article>
          <span>最近处理</span>
          <strong>{processedCount.toString().padStart(2, "0")}</strong>
          <small>条已完成</small>
        </article>
        <article>
          <span>今日专注</span>
          <strong>{latestDaily?.focus_minutes ?? 0}</strong>
          <small>分钟</small>
        </article>
        <article>
          <span>待处理</span>
          <strong>
            {snapshot.records.filter((record) =>
              !["processed", "synced"].includes(record.status)
            ).length.toString().padStart(2, "0")}
          </strong>
          <small>条队列</small>
        </article>
      </section>

      <section className="content-section" id="records">
        <div className="section-heading">
          <div>
            <p className="section-kicker">RECENT NOTES</p>
            <h2>最近录音</h2>
          </div>
          <p>播放地址会在 15 分钟后失效，刷新页面即可重新获取。</p>
        </div>
        <div className="record-grid">
          {snapshot.records.length > 0
            ? snapshot.records.map((record) => (
              <RecordCard key={record.id} record={record} />
            ))
            : <EmptyState>还没有录音。设备下一次上传后会出现在这里。</EmptyState>}
        </div>
      </section>

      <section className="review-section" id="daily">
        <div className="section-heading light">
          <div>
            <p className="section-kicker">DAILY REVIEW</p>
            <h2>每日日报</h2>
          </div>
          <p>每天北京时间 00:10 自动整理前一天。</p>
        </div>
        <div className="daily-grid">
          {snapshot.daily_reviews.length > 0
            ? snapshot.daily_reviews.map((review) => (
              <article className="daily-card" key={review.id}>
                <div className="daily-date">
                  <strong>{formatReviewDate(review.review_date)}</strong>
                  <span className={statusTone(review.status)}>
                    {statusLabels[review.status] ?? review.status}
                  </span>
                </div>
                <p>
                  {review.narrative?.trim() ||
                    (review.status === "failed"
                      ? "这一天的事实已经保存，叙述生成暂时失败。"
                      : "这一天还没有生成叙述。")}
                </p>
                <dl>
                  <div>
                    <dt>完成</dt>
                    <dd>{review.completed_items.length}</dd>
                  </div>
                  <div>
                    <dt>灵感</dt>
                    <dd>{review.idea_count}</dd>
                  </div>
                  <div>
                    <dt>收件</dt>
                    <dd>{review.inbox_count}</dd>
                  </div>
                  <div>
                    <dt>专注</dt>
                    <dd>{review.focus_minutes}m</dd>
                  </div>
                </dl>
              </article>
            ))
            : <EmptyState>第一份日报会在有录音数据后自动出现。</EmptyState>}
        </div>
      </section>

      <section className="weekly-section" id="weekly">
        <div className="weekly-intro">
          <p className="section-kicker">WEEKLY REVIEW</p>
          <h2>一周，慢慢浮现出形状。</h2>
          <p>
            周报能力已经准备好；开启定时任务后，它会从每天的事实中整理本周成果、
            投入方向和下周重点。
          </p>
        </div>
        <article className="weekly-card">
          {latestWeekly
            ? (
              <>
                <div className="weekly-card-head">
                  <span>{latestWeekly.week_start} — {latestWeekly.week_end}</span>
                  <span className={statusTone(latestWeekly.status)}>
                    {statusLabels[latestWeekly.status] ?? latestWeekly.status}
                  </span>
                </div>
                <h3>{latestWeekly.narrative || "这是一个没有记录的安静星期。"}</h3>
                <div className="weekly-metrics">
                  <div>
                    <strong>{latestWeekly.pomodoro_count}</strong>
                    <span>个番茄</span>
                  </div>
                  <div>
                    <strong>{latestWeekly.focus_minutes}</strong>
                    <span>分钟专注</span>
                  </div>
                  <div>
                    <strong>{latestWeekly.major_outcomes.length}</strong>
                    <span>项成果</span>
                  </div>
                </div>
              </>
            )
            : (
              <EmptyState>
                周报定时任务尚未启用；当前不会产生额外模型调用。
              </EmptyState>
            )}
        </article>
      </section>

      <footer>
        <div className="brand footer-brand">
          <span className="brand-mark">声</span>
          <span>声笺</span>
        </div>
        <p>私人语音收件箱 · Asia/Shanghai</p>
        <p>数据更新时间：{formatDateTime(snapshot.generated_at)}</p>
      </footer>
    </main>
  );
}
