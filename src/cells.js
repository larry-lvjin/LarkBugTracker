// SDK 0.5: 文本 IOpenSegment[]；单选 {id,text}；自动编号 {value,status}；日期 number。
export function text(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (Array.isArray(value)) return value.map(segment => typeof segment === 'string' ? segment : String(segment?.text ?? segment?.value ?? '')).join('').trim();
  if (typeof value === 'object') {
    if (value.status === 'calculating') return '';
    return text(value.text ?? value.name ?? value.value ?? '');
  }
  return '';
}
export function selectText(value, meta) {
  if (value == null) return '';
  const single = Array.isArray(value) ? value[0] : value;
  const id = typeof single === 'object' ? single?.id : single;
  const options = meta?.property?.options;
  const option = options?.find(item => item.id === id);
  if (Array.isArray(options) && typeof id === 'string' && id && !option) {
    if (typeof single === 'string' && options.some(item => item.name === single)) return single;
    throw new Error(`字段「${meta.name ?? '单选'}」出现未知选项，需重新读取元数据。`);
  }
  return option?.name ?? text(single);
}
export function nonNegativeInteger(value) {
  const raw = typeof value === 'number' ? value : text(value);
  if (raw === '' || raw == null) return null;
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
export function indexFields(list) {
  const byName = new Map();
  for (const field of list) {
    if (byName.has(field.name)) throw new Error(`存在同名字段「${field.name}」，请先只读核对配置。`);
    byName.set(field.name, field);
  }
  return byName;
}
export function requireFields(list, names) {
  const fields = indexFields(list);
  const missing = names.filter(name => !fields.has(name));
  if (missing.length) throw new Error(`缺少字段：${missing.join('、')}。插件不会自动补建字段。`);
  return fields;
}
export function fieldValue(record, fields, name) { return record.fields?.[fields.get(name)?.id]; }
