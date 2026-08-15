export type VoiceRecord = {
  id: string;
  event_id: string;
  device_id: string;
  captured_at: string | null;
  received_at: string;
  raw_text: string | null;
  clean_text: string | null;
  record_type: string | null;
  title: string | null;
  summary: string | null;
  project: string | null;
  tags: string[];
  duration_minutes: number | null;
  completed: boolean | null;
  confidence: number | null;
  status: string;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  audio_url: string | null;
  audio_url_expires_in_seconds: number | null;
  audio_duration_seconds: number | null;
};

export type DailyReview = {
  id: string;
  review_date: string;
  timezone: string;
  completed_items: unknown[];
  pomodoro_count: number;
  focus_minutes: number;
  idea_count: number;
  inbox_count: number;
  facts: Record<string, unknown>;
  narrative: string | null;
  prompt_version: string | null;
  status: string;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

export type WeeklyReview = {
  id: string;
  week_start: string;
  week_end: string;
  timezone: string;
  major_outcomes: unknown[];
  project_investment: Record<string, unknown>;
  unfinished_items: unknown[];
  next_focus: unknown[];
  pomodoro_count: number;
  focus_minutes: number;
  facts: Record<string, unknown>;
  narrative: string | null;
  prompt_version: string | null;
  status: string;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

export type DeviceSnapshot = {
  id: string;
  enabled: boolean;
  firmware_version: string | null;
  last_seen_at: string | null;
  updated_at: string;
};

export type DashboardSnapshot = {
  generated_at: string;
  records: VoiceRecord[];
  daily_reviews: DailyReview[];
  weekly_reviews: WeeklyReview[];
  devices: DeviceSnapshot[];
};

export type DashboardLoadResult = {
  snapshot: DashboardSnapshot;
  preview: boolean;
  error: string | null;
};

const emptySnapshot = (): DashboardSnapshot => ({
  generated_at: new Date().toISOString(),
  records: [],
  daily_reviews: [],
  weekly_reviews: [],
  devices: [],
});

const previewSnapshot = (): DashboardSnapshot => {
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const generatedAt = now.toISOString();

  return {
    generated_at: generatedAt,
    devices: [{
      id: "demo-device-001",
      enabled: true,
      firmware_version: "0.8.0-pomodoro-ui",
      last_seen_at: new Date(now.getTime() - 4 * 60_000).toISOString(),
      updated_at: generatedAt,
    }],
    records: [
      {
        id: "preview-record-001",
        event_id: "preview-event-001",
        device_id: "demo-device-001",
        captured_at: new Date(now.getTime() - 12 * 60_000).toISOString(),
        received_at: new Date(now.getTime() - 11 * 60_000).toISOString(),
        raw_text: "记录一个用蓝色指示待同步状态的界面想法。",
        clean_text: "记录一个用蓝色指示待同步状态的界面想法。",
        record_type: "idea",
        title: "待同步状态指示",
        summary: "用蓝色状态提示设备仍有内容等待同步。",
        project: "设备体验",
        tags: ["界面", "同步"],
        duration_minutes: null,
        completed: false,
        confidence: 0.94,
        status: "processed",
        error_code: null,
        created_at: generatedAt,
        updated_at: generatedAt,
        audio_url: null,
        audio_url_expires_in_seconds: null,
        audio_duration_seconds: 5.2,
      },
      {
        id: "preview-record-002",
        event_id: "preview-event-002",
        device_id: "demo-device-001",
        captured_at: new Date(now.getTime() - 3 * 60 * 60_000).toISOString(),
        received_at: new Date(now.getTime() - 3 * 60 * 60_000).toISOString(),
        raw_text: "明天提醒我测试离线录音恢复。",
        clean_text: "明天提醒我测试离线录音恢复。",
        record_type: "task",
        title: "测试离线录音恢复",
        summary: "明天验证断网录音在恢复网络后可以继续上传。",
        project: "可靠性测试",
        tags: ["离线", "测试"],
        duration_minutes: null,
        completed: false,
        confidence: 0.91,
        status: "processed",
        error_code: null,
        created_at: generatedAt,
        updated_at: generatedAt,
        audio_url: null,
        audio_url_expires_in_seconds: null,
        audio_duration_seconds: 4.7,
      },
    ],
    daily_reviews: [{
      id: "preview-daily-001",
      review_date: today,
      timezone: "Asia/Shanghai",
      completed_items: [],
      pomodoro_count: 2,
      focus_minutes: 50,
      idea_count: 1,
      inbox_count: 2,
      facts: { record_count: 2 },
      narrative: "今天记录了一个界面想法，并安排了离线恢复测试。",
      prompt_version: "daily-review-v1",
      status: "generated",
      error_code: null,
      created_at: generatedAt,
      updated_at: generatedAt,
    }],
    weekly_reviews: [{
      id: "preview-weekly-001",
      week_start: today,
      week_end: today,
      timezone: "Asia/Shanghai",
      major_outcomes: [],
      project_investment: {},
      unfinished_items: [],
      next_focus: ["完成离线恢复测试"],
      pomodoro_count: 2,
      focus_minutes: 50,
      facts: { record_count: 2 },
      narrative: "本周示例聚焦于设备反馈和离线可靠性。",
      prompt_version: "weekly-review-v1",
      status: "generated",
      error_code: null,
      created_at: generatedAt,
      updated_at: generatedAt,
    }],
  };
};

function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<DashboardSnapshot>;
  return typeof candidate.generated_at === "string" &&
    Array.isArray(candidate.records) &&
    Array.isArray(candidate.daily_reviews) &&
    Array.isArray(candidate.weekly_reviews) &&
    Array.isArray(candidate.devices);
}

export async function loadDashboardSnapshot(): Promise<DashboardLoadResult> {
  const endpoint = process.env.DASHBOARD_API_URL?.trim();
  const token = process.env.DASHBOARD_READ_TOKEN?.trim();

  if (!endpoint || !token) {
    if (process.env.NODE_ENV === "development") {
      return { snapshot: previewSnapshot(), preview: true, error: null };
    }
    return {
      snapshot: emptySnapshot(),
      preview: false,
      error: "查看入口尚未配置正式数据连接。",
    };
  }

  try {
    const response = await fetch(`${endpoint}?limit=20`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        snapshot: emptySnapshot(),
        preview: false,
        error: `数据服务暂时不可用（HTTP ${response.status}）。`,
      };
    }
    const data: unknown = await response.json();
    if (!isDashboardSnapshot(data)) {
      return {
        snapshot: emptySnapshot(),
        preview: false,
        error: "数据服务返回了无法识别的格式。",
      };
    }
    return { snapshot: data, preview: false, error: null };
  } catch {
    return {
      snapshot: emptySnapshot(),
      preview: false,
      error: "数据服务暂时无法连接。",
    };
  }
}
