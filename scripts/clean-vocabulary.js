const fs = require('fs');
const path = require('path');

// 常见短语与核心词汇补充字典 (内置高质量教学音标与释义库)
const CORE_DICT = {
  // 常见短语补全
  'for long': { uk: 'fɔː lɒŋ', us: 'fɔːr lɔːŋ', meaning: 'adv. 长久地；很长时间' },
  'as follows': { uk: 'æz ˈfɒləʊz', us: 'æz ˈfɑːloʊz', meaning: 'adv. 如下' },
  'because of': { uk: 'bɪˈkɒz ɒv', us: 'bɪˈkɔːz əv', meaning: 'prep. 因为；由于' },
  'compare a with b': { uk: 'kəmˈpeə aɪ wɪð biː', us: 'kəmˈper eɪ wɪð biː', meaning: 'v. 把A与B进行比较' },
  'mistake a for b': { uk: 'mɪˈsteɪk aɪ fɔː biː', us: 'mɪˈsteɪk eɪ fɔːr biː', meaning: 'v. 把A误认为是B' },
  'stick to something': { uk: 'stɪk tuː ˈsʌmθɪŋ', us: 'stɪk tuː ˈsʌmθɪŋ', meaning: 'v. 坚持某事；紧贴某物' },
  'take your advice': { uk: 'teɪk jɔː ədˈvaɪs', us: 'teɪk jʊr ədˈvaɪs', meaning: 'v. 接受你的建议' },
  'contrast a with b': { uk: 'ˈkɒntrɑːst aɪ wɪð biː', us: 'ˈkɑːntræst eɪ wɪð biː', meaning: 'v. 使A与B形成对比' },
  'be likely to do': { uk: 'biː ˈlaɪkli tuː duː', us: 'biː ˈlaɪkli tuː duː', meaning: 'v. 可能做某事' },
  'range from a to b': { uk: 'reɪndʒ frɒm aɪ tuː biː', us: 'reɪndʒ frəm eɪ tuː biː', meaning: 'v. 范围从A到B' },
  'compare a to b': { uk: 'kəmˈpeə aɪ tuː biː', us: 'kəmˈper eɪ tuː biː', meaning: 'v. 把A比作B；比较A与B' },
  'distinguish a from b': { uk: 'dɪˈstɪŋɡwɪʃ aɪ frɒm biː', us: 'dɪˈstɪŋɡwɪʃ eɪ frəm biː', meaning: 'v. 区分A和B；把A与B区别开' },
  'call for something': { uk: 'kɔːl fɔː ˈsʌmθɪŋ', us: 'kɔːl fɔːr ˈsʌmθɪŋ', meaning: 'v. 需要某物；呼吁某事' },
  'invest in something': { uk: 'ɪnˈvest ɪn ˈsʌmθɪŋ', us: 'ɪnˈvest ɪn ˈsʌmθɪŋ', meaning: 'v. 投资于某事' },
  'build up': { uk: 'bɪld ʌp', us: 'bɪld ʌp', meaning: 'v. 建立；增强；增进' },
  'breakthrough': { uk: 'ˈbreɪkθruː', us: 'ˈbreɪkθruː', meaning: 'n. 突破；重大进展' },
  'go on': { uk: 'ɡəʊ ɒn', us: 'ɡoʊ ɑːn', meaning: 'v. 继续进行；发生' },
  'carbon dioxide': { uk: 'ˈkɑːbən daɪˈɒksaɪd', us: 'ˈkɑːrbən daɪˈɑːksaɪd', meaning: 'n. 二氧化碳' },
  'lay down': { uk: 'leɪ daʊn', us: 'leɪ daʊn', meaning: 'v. 放下；制定；牺牲' },
  'be busy with': { uk: 'biː ˈbɪzi wɪð', us: 'biː ˈbɪzi wɪð', meaning: 'v. 忙于……' },
  'a bowl of something': { uk: 'ə bəʊl ɒv ˈsʌmθɪŋ', us: 'ə boʊl əv ˈsʌmθɪŋ', meaning: 'n. 一碗……' },
  'play the drums': { uk: 'pleɪ ðə drʌmz', us: 'pleɪ ðə drʌmz', meaning: 'v. 敲鼓；打鼓' },
  'follow the rules': { uk: 'ˈfɒləʊ ðə ruːlz', us: 'ˈfɑːloʊ ðə ruːlz', meaning: 'v. 遵守规则' },
  'read a newspaper': { uk: 'riːd ə ˈnjuːzpeɪpə', us: 'riːd ə ˈnuːzpeɪpər', meaning: 'v. 读报纸' },
  'make soup': { uk: 'meɪk suːp', us: 'meɪk suːp', meaning: 'v. 做汤' },
  'on a vacation': { uk: 'ɒn ə vəˈkeɪʃn', us: 'ɑːn ə veɪˈkeɪʃn', meaning: 'adv. 在度假中' },
  'enjoy reading': { uk: 'ɪnˈdʒɔɪ ˈriːdɪŋ', us: 'ɪnˈdʒɔɪ ˈriːdɪŋ', meaning: 'v. 喜欢阅读' },
  'of medium height': { uk: 'ɒv ˈmiːdiəm haɪt', us: 'əv ˈmiːdiəm haɪt', meaning: 'adj. 中等身高的' },

  // 常见缺失单词补全样本
  'beach': { uk: 'biːtʃ', us: 'biːtʃ', meaning: 'n. 海滩；沙滩' },
  'rose': { uk: 'rəʊz', us: 'roʊz', meaning: 'n. 玫瑰，月季；玫瑰色\nv. rise的过去式' },
  'where': { uk: 'weə(r)', us: 'wer', meaning: 'adv. 在哪里；到哪里\nconj. 在……地方\npron. 哪里' },
  'hope': { uk: 'həʊp', us: 'hoʊp', meaning: 'v. 希望；期望\nn. 希望；期望' },
  'shine': { uk: 'ʃaɪn', us: 'ʃaɪn', meaning: 'v. 照耀；发光；杰出\nn. 光亮；光泽' },
  'star': { uk: 'stɑː(r)', us: 'stɑːr', meaning: 'n. 星，恒星；明星\nv. 主演；用星号标出' },
  'rain': { uk: 'reɪn', us: 'reɪn', meaning: 'n. 雨，雨水\nv. 下雨' },
  'alert': { uk: 'əˈlɜːt', us: 'əˈlɜːrt', meaning: 'adj. 警觉的；机警的\nn. 警报\nv. 警告；使警觉' },
  'barbecue': { uk: 'ˈbɑːbɪkjuː', us: 'ˈbɑːrbɪkjuː', meaning: 'n. 户外烧烤；烤肉\nv. 烧烤' },
  'identical': { uk: 'aɪˈdentɪkl', us: 'aɪˈdentɪkl', meaning: 'adj. 完全相同的；极相似的' },
  'mutual': { uk: 'ˈmjuːtʃuəl', us: 'ˈmjuːtʃuəl', meaning: 'adj. 相互的；共有的' },
  'resort': { uk: 'rɪˈzɔːt', us: 'rɪˈzɔːrt', meaning: 'n. 度假胜地；求助，诉诸\nv. 诉诸；求助' },
  'romantic': { uk: 'rəʊˈmæntɪk', us: 'roʊˈmæntɪk', meaning: 'adj. 浪漫的；传奇的' },
  'snack': { uk: 'snæk', us: 'snæk', meaning: 'n. 小吃，点心\nv. 吃零食' },
  'pencil box': { uk: 'ˈpensl bɒks', us: 'ˈpensl bɑːks', meaning: 'n. 铅笔盒；文具盒' }
};

// 音标清洗规范化
function cleanPhonetic(phonetic) {
  if (!phonetic || phonetic === '无' || phonetic === 'None') return '无';
  let str = String(phonetic).trim();
  // 剥离外围成对的 [] 或 //
  if ((str.startsWith('[') && str.endsWith(']')) || (str.startsWith('/') && str.endsWith('/'))) {
    str = str.slice(1, -1).trim();
  }
  // 剥离多余内层
  str = str.replace(/^\[+|\/+|\----+\]+$/g, '').trim();
  return str || '无';
}

// 词性标准化映射表
const POS_MAP = {
  'n': 'n.', 'n.': 'n.', 'n：': 'n.', 'noun': 'n.',
  'v': 'v.', 'v.': 'v.', 'v：': 'v.', 'verb': 'v.',
  'vt': 'vt.', 'vt.': 'vt.', 'vi': 'vi.', 'vi.': 'vi.',
  'adj': 'adj.', 'adj.': 'adj.', 'a': 'adj.', 'a.': 'adj.', 'adj：': 'adj.',
  'adv': 'adv.', 'adv.': 'adv.', 'ad': 'adv.', 'ad.': 'adv.', 'adv：': 'adv.',
  'prep': 'prep.', 'prep.': 'prep.',
  'conj': 'conj.', 'conj.': 'conj.',
  'pron': 'pron.', 'pron.': 'pron.',
  'num': 'num.', 'num.': 'num.',
  'art': 'art.', 'art.': 'art.',
  'interj': 'interj.', 'interj.': 'interj.',
  'abbr': 'abbr.', 'abbr.': 'abbr.',
  'phrase': 'phrase.', 'phrase.': 'phrase.'
};

// 释义清洗与词性规范化
function cleanMeaning(meaning) {
  if (!meaning || meaning === '无' || meaning === 'None') return '无';
  let str = String(meaning).trim();
  if (!str) return '无';

  // 清除前导多余符号或首行连续空格
  str = str.replace(/^\s+/, '');

  // 统一换行符
  const lines = str.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const cleanedLines = [];

  for (let line of lines) {
    // 匹配词性开头，例如 n. adj. vt. 等
    let posMatch = line.match(/^([a-zA-Z]{1,6}[\.\：]?)\s*(.*)/);
    let pos = '';
    let body = line;

    if (posMatch) {
      const rawPos = posMatch[1].toLowerCase().replace('：', '.');
      if (POS_MAP[rawPos]) {
        pos = POS_MAP[rawPos];
        body = posMatch[2];
      }
    }

    // 格式化 body 中的分隔符为中文分号 ；
    // 把英文分号 ; 或英文逗号 , 替换为中文分号（注意保留数字和小数点）
    body = body.replace(/;/g, '；');
    // 如果内部有英文逗号分隔义项，转为中文分号
    body = body.replace(/,\s*/g, '；');
    // 把连续多余空格缩减
    body = body.replace(/\s+/g, ' ').trim();
    // 剔除末尾多余分号
    body = body.replace(/；+$/g, '');

    // 去除特定行业极罕见噪声前缀标签（如 [计] [测] 等）
    body = body.replace(/\[(计|测|医|化|商|电|法|生)\]\s*/g, '');

    if (pos) {
      cleanedLines.push(`${pos} ${body}`);
    } else {
      if (body) {
        cleanedLines.push(body);
      }
    }
  }

  const result = cleanedLines.join('\n').trim();
  return result || '无';
}

module.exports = {
  CORE_DICT,
  cleanPhonetic,
  cleanMeaning
};
