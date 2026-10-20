import type { Jev } from "../../providers/jev.js";
export type GuideScene = "study" | "life" | "mood";
export const moodWords = /委屈|难过|想哭|孤独|心累|分手|伤心|烦躁|压抑/;
export const mixedWords = /迷茫|焦虑|压力(?:很|太)?大/;
export const studyWords = /[=∫∑√]|极限|导数|积分|微分|函数|知识点|题目/;
export function entryScene(entry: string | undefined, text: string) {
  if (entry !== "jot") return { scene: "study" as GuideScene, moodCandidate: false };
  if (studyWords.test(text)) return { scene: "study" as GuideScene, moodCandidate: false };
  return { scene: "life" as GuideScene, moodCandidate: moodWords.test(text) };
}
export const needsSceneJudge = (text: string) =>
  !studyWords.test(text) && !moodWords.test(text) && !mixedWords.test(text);
export async function classifyScene(judge: Pick<Jev, "choice">, text: string, signal?: AbortSignal) {
  try {
    const result = await judge.choice(text, "判断文字更适合学习、生活、心情，或感受和选择混在一起；只在明显感受表达时选心情。", { study: "题目、公式或知识点", life: "计划、选择或一般想法", mood: "感受或想倾诉的事", mixed: "感受和选择混在一起" }, signal);
    return result.confidence >= 0.6 && ["study", "life", "mood"].includes(result.choice)
      ? result.choice as GuideScene : "life" as GuideScene;
  } catch { return "life" as GuideScene; }
}
