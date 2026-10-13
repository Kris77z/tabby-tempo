/** Agora-style commands, limited to tools the hosted executor actually has. */
export const goalPresets = [
 {id:'write',label:'// 写作',aliases:['// write','// 写作'],field:'写作需求',placeholder:'主题、受众、篇幅与语气',prefix:'请按以下要求完成写作，直接给出可使用的正文：\n'},
 {id:'analyze',label:'// 分析',aliases:['// analyze','// 分析'],field:'待分析资料',placeholder:'粘贴资料或数据，并说明要回答的问题',prefix:'请分析以下提供的资料，区分事实、推断与建议；缺失信息请明确说明，不编造数据：\n'},
 {id:'review',label:'// 审阅代码',aliases:['// review','// 审阅代码'],field:'代码与要求',placeholder:'粘贴代码和关注的问题',prefix:'请审阅以下代码，说明具体问题、修复方案和建议的测试。没有实际运行代码，不要声称已运行：\n'},
] as const;
export function expandGoalCommand(raw:string):string {
 const text=raw.trim();
 if(!text.startsWith('//'))return text;
 for(const preset of goalPresets)for(const alias of preset.aliases){
  if(text===alias)throw new Error(`请在 ${alias} 后补充${preset.field}。`);
  if(text.startsWith(alias+' ')||text.startsWith(alias+'\n'))return preset.prefix+text.slice(alias.length).trim();
 }
 throw new Error('未知快捷指令，请选择写作、分析或审阅代码，也可以直接描述任务。');
}
