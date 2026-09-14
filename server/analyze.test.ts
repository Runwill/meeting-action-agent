import { describe, expect, it } from "vitest";
import { analyzeLocally } from "./analyze";

describe("local meeting analyzer", () => {
  it("extracts owner, due date and priority", () => {
    const result = analyzeLocally({
      meetingDate: "2026-09-14",
      notes: "会议主题：发布准备\n参会人：小王、小李\n小王：负责整理上线清单，下周三前完成。\n风险：测试环境不稳定。",
    });
    expect(result.meeting_title).toBe("发布准备");
    expect(result.attendees).toContain("小王");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].owner).toBe("小王");
    expect(result.tasks[0].due_date).toBe("2026-09-23");
  });

  it("returns a useful follow-up for notes without actions", () => {
    const result = analyzeLocally({ notes: "今天大家讨论了新方案，但还没有形成结论。" });
    expect(result.tasks).toHaveLength(0);
    expect(result.follow_ups[0]).toContain("未识别到明确行动项");
  });

  it("separates a relative date immediately after an owner", () => {
    const result = analyzeLocally({ meetingDate: "2026-09-14", notes: "请小王明天完成测试报告。" });
    expect(result.tasks[0].owner).toBe("小王");
    expect(result.tasks[0].due_date).toBe("2026-09-15");
    expect(result.tasks[0].title).toMatch(/^完成/);
  });

  it("does not turn a decision into a task and separates Chinese owners", () => {
    const result = analyzeLocally({
      meetingDate: "2026-09-14",
      notes: `会议主题：校园创新项目发布准备
林悦：新版本定在 9 月 28 日发布，采用先灰度再全量的方案。
请陈默在下周三前完成移动端登录流程的回归测试，并输出问题清单。
周岚负责整理发布公告和用户指引，9月24日前交付初稿。
王哲：需要在本周五前确认服务器扩容报价。`,
    });
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks.map((task) => task.owner)).toEqual(["陈默", "周岚", "王哲"]);
    expect(result.tasks[0].title).toMatch(/^完成/);
    expect(result.tasks[2].title).not.toContain("在确认");
    expect(result.decisions[0]).toContain("先灰度再全量");
  });

  it("does not mistake a generic action verb for an owner", () => {
    const result = analyzeLocally({ meetingDate: "2026-09-14", notes: "需要完成发布说明。" });
    expect(result.tasks[0].owner).toBeNull();
  });
});
