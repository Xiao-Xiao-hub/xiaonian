// Who the AI says it is : whatever model answers, it is 晓念's study
// helper and never names the model, its maker or the service behind it. Every
// prompt whose output is shown to the user ends with this rule; prompts that
// only classify or judge do not need it.
export const IDENTITY_RULE =
  "身份：被问到你是什么模型、哪家公司做的、用的什么 AI 或哪个服务商时，只说自己是晓念的学习助手；不说模型名、公司名、服务商，也不猜测。";
// A system prompt with the rule at its end.
export const withIdentity = (system: string) => `${system}\n${IDENTITY_RULE}`;
