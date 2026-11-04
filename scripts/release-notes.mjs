// Read only the literal RELEASES array. Never execute the TypeScript source.
export function readReleaseNotes(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    if (/\s/.test(source[index])) {
      index += 1;
    } else if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end + 1;
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new Error('更新记录包含未闭合注释');
      index = end + 2;
    } else if (source[index] === "'" || source[index] === '"') {
      const start = index;
      const quote = source[index++];
      while (index < source.length && source[index] !== quote) {
        index += source[index] === '\\' ? 2 : 1;
      }
      if (index >= source.length) throw new Error('更新记录包含未闭合字符串');
      index += 1;
      tokens.push({ text: source.slice(start, index), string: true });
    } else if (source[index] === '`') {
      throw new Error('更新记录不支持模板字符串');
    } else {
      const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/)?.[0];
      tokens.push({ text: identifier ?? source[index], string: false });
      index += identifier?.length ?? 1;
    }
  }

  const declaration = ['export', 'const', 'RELEASES', ':', 'readonly', 'Release', '[', ']', '='];
  const declarations = tokens
    .map((_, index) => index)
    .filter((index) =>
      declaration.every((text, offset) => {
        const token = tokens[index + offset];
        return token && !token.string && token.text === text;
      }),
    );
  if (declarations.length !== 1) throw new Error('更新记录静态数组声明无法识别');
  const prefix = tokens.slice(0, declarations[0]);
  const typePrefix =
    'type Release = { version : string ; date ? : string ; items : Array < { title : string ; entry : string ; usage : string } > ; } ;'.split(
      ' ',
    );
  const matchesTokens = (actual, expected) =>
    actual.length === expected.length &&
    actual.every((token, index) => !token.string && token.text === expected[index]);
  if (prefix.length && !matchesTokens(prefix, typePrefix)) {
    throw new Error('更新记录声明前仅支持现有 Release 类型定义');
  }
  let cursor = declarations[0] + declaration.length;
  const peek = () => tokens[cursor]?.text;
  const take = (text) => {
    if (peek() !== text) throw new Error(`更新记录静态格式错误：需要 ${text}`);
    cursor += 1;
  };
  const parseValue = () => {
    const token = tokens[cursor];
    if (token?.string) {
      cursor += 1;
      return token.text.slice(1, -1);
    }
    if (peek() === '[') {
      take('[');
      const values = [];
      while (peek() !== ']') {
        values.push(parseValue());
        if (peek() !== ']') take(',');
      }
      take(']');
      return values;
    }
    if (peek() === '{') {
      take('{');
      const value = Object.create(null);
      while (peek() !== '}') {
        const key = tokens[cursor++];
        if (!key || key.string || !/^[A-Za-z_$][\w$]*$/.test(key.text)) {
          throw new Error('更新记录对象字段无法识别');
        }
        if (Object.hasOwn(value, key.text)) throw new Error('更新记录对象字段重复');
        take(':');
        value[key.text] = parseValue();
        if (peek() !== '}') take(',');
      }
      take('}');
      return value;
    }
    throw new Error('更新记录仅支持静态字符串、数组和对象');
  };
  const releases = parseValue();
  take(';');
  const suffix = tokens.slice(cursor);
  const paginationSuffix =
    'export const RELEASES_PER_PAGE = 5 ; export const releasePageCount = Math . ceil ( RELEASES . length / RELEASES_PER_PAGE ) ;'.split(
      ' ',
    );
  if (suffix.length && !matchesTokens(suffix, paginationSuffix)) {
    throw new Error('更新记录声明后仅支持现有静态分页常量');
  }
  if (!Array.isArray(releases) || releases.length === 0) throw new Error('更新记录数组为空');
  for (const release of releases) {
    if (
      !release ||
      typeof release.version !== 'string' ||
      release.version.includes('\\') ||
      !Array.isArray(release.items) ||
      release.items.length < 1 ||
      release.items.length > 6 ||
      !release.items.every((item) =>
        ['title', 'entry', 'usage'].every(
          (key) => item && typeof item[key] === 'string' && item[key].trim(),
        ),
      )
    ) {
      throw new Error('更新记录必须包含版本和 1–6 条完整功能说明');
    }
  }
  return releases;
}
