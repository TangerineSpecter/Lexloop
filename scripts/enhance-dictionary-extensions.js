const fs = require('fs');
const path = require('path');
const XLSX = require('../apps/api/node_modules/xlsx');
const { cleanPhonetic, cleanMeaning } = require('./clean-vocabulary');

// 扩展短语与考纲高频派生词字典库
const EXTENDED_PHRASE_DICT = {
  'make or earn a living': { uk: 'meɪk ɔː ɜːn ə ˈlɪvɪŋ', us: 'meɪk ɔːr ɜːrn ə ˈlɪvɪŋ', meaning: 'v. 谋生' },
  'make a living': { uk: 'meɪk ə ˈlɪvɪŋ', us: 'meɪk ə ˈlɪvɪŋ', meaning: 'v. 谋生' },
  'earn a living': { uk: 'ɜːn ə ˈlɪvɪŋ', us: 'ɜːrn ə ˈlɪvɪŋ', meaning: 'v. 谋生' },
  'carbon dioxide': { uk: 'ˈkɑːbən daɪˈɒksaɪd', us: 'ˈkɑːrbən daɪˈɑːksaɪd', meaning: 'n. 二氧化碳' },
  'a link between a and b': { uk: 'ə lɪŋk bɪˈtwiːn aɪ ænd biː', us: 'ə lɪŋk bɪˈtwiːn eɪ ænd biː', meaning: 'n. A与B之间的联系' },
  'a range of something': { uk: 'ə reɪndʒ ɒv ˈsʌmθɪŋ', us: 'ə reɪndʒ əv ˈsʌmθɪŋ', meaning: 'n. 一系列的……；各种各样的……' },
  'be optimistic about something': { uk: 'biː ˌɒptɪˈmɪstɪk əˈbaʊt ˈsʌmθɪŋ', us: 'biː ˌɑːptɪˈmɪstɪk əˈbaʊt ˈsʌmθɪŋ', meaning: 'v. 对某事抱乐观态度' },
  'confuse a with b': { uk: 'kənˈfjuːz aɪ wɪð biː', us: 'kənˈfjuːz eɪ wɪð biː', meaning: 'v. 把A与B混淆' },
  'stick to something stick with': { uk: 'stɪk tuː ˈsʌmθɪŋ', us: 'stɪk tuː ˈsʌmθɪŋ', meaning: 'v. 坚持某事；跟随某人' },
  'change from a to b': { uk: 'tʃeɪndʒ frɒm aɪ tuː biː', us: 'tʃeɪndʒ frəm eɪ tuː biː', meaning: 'v. 从A转变为B' },
  'adapt to something': { uk: 'əˈdæpt tuː ˈsʌmθɪŋ', us: 'əˈdæpt tuː ˈsʌmθɪŋ', meaning: 'v. 适应某事' },
  'replace a with b': { uk: 'rɪˈpleɪs aɪ wɪð biː', us: 'rɪˈpleɪs eɪ wɪð biː', meaning: 'v. 用B替换A' },
  'between ... and ...': { uk: 'bɪˈtwiːn ænd', us: 'bɪˈtwiːn ænd', meaning: 'prep. 在……和……之间' },
  'be in great danger': { uk: 'biː ɪn ɡreɪt ˈdeɪndʒə', us: 'biː ɪn ɡreɪt ˈdeɪndʒər', meaning: 'v. 处于巨大危险中' },
  'be of medium height': { uk: 'biː ɒv ˈmiːdiəm haɪt', us: 'biː əv ˈmiːdiəm haɪt', meaning: 'v. 中等身材' },
  "take one's order": { uk: 'teɪk wʌnz ˈɔːdə', us: 'teɪk wʌnz ˈɔːrdər', meaning: 'v. 听取某人的点菜；接受订货' },
  'go along the street': { uk: 'ɡəʊ əˈlɒŋ ðə striːt', us: 'ɡoʊ əˈlɔːŋ ðə striːt', meaning: 'v. 沿着街道走' }
};

function processExtensions() {
  const rootDir = path.resolve(__dirname, '../apps/api/assets/vocabulary');

  function getAllFiles(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
      const filePath = path.join(dir, file);
      if (fs.statSync(filePath).isDirectory()) {
        getAllFiles(filePath, fileList);
      } else if (file.endsWith('.xlsx') && !file.startsWith('~$')) {
        fileList.push(filePath);
      }
    });
    return fileList;
  }

  const files = getAllFiles(rootDir);
  let updatedRowsCount = 0;

  for (const file of files) {
    try {
      const workbook = XLSX.readFile(file);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      if (!rows || rows.length === 0) continue;

      const newRows = [ ['单词', '英音', '美音', '释义'] ];
      let modified = false;

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || (!row[0] && !row[1] && !row[2] && !row[3])) continue;

        const word = String(row[0] || '').trim();
        const lowerWord = word.toLowerCase();
        let uk = String(row[1] || '').trim();
        let us = String(row[2] || '').trim();
        let meaning = String(row[3] || '').trim();

        if (EXTENDED_PHRASE_DICT[lowerWord]) {
          const ext = EXTENDED_PHRASE_DICT[lowerWord];
          if (uk === '无') { uk = ext.uk; modified = true; }
          if (us === '无') { us = ext.us; modified = true; }
          if (meaning === '无') { meaning = ext.meaning; modified = true; }
          updatedRowsCount++;
        }

        newRows.push([word, uk, us, meaning]);
      }

      if (modified) {
        const newSheet = XLSX.utils.aoa_to_sheet(newRows);
        workbook.Sheets[sheetName] = newSheet;
        XLSX.writeFile(workbook, file);
      }

    } catch (e) {
      console.error(`Error extending ${file}:`, e.message);
    }
  }

  console.log(`Extended cleaning complete. Updated ${updatedRowsCount} phrase entries.`);
}

processExtensions();
