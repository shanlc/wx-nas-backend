// 从微信云开发导出的 JSON 批量导入：node tools/import.js <服务器地址> <token> <集合名> <文件.json>
// 文件格式：JSON 数组，例如 [{"title":"第一条","content":"..."}]
// token 获取：先在小程序登录一次，把 wx.getStorageSync('token') 的值贴过来；或本地用 dev-login 接口拿。
const fs = require('fs');
async function main() {
  const [base, token, collection, file] = process.argv.slice(2);
  if (!base || !token || !collection || !file) {
    console.error('用法: node tools/import.js http://NAS_IP:3000 <token> <collection> <file.json>');
    process.exit(1);
  }
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(items)) throw new Error('文件须为 JSON 数组');
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500);
    const r = await fetch(`${base}/api/data/${collection}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ items: chunk }),
    });
    console.log(i, await r.text());
    if (!r.ok) process.exit(1);
  }
  console.log('导入完成', items.length);
}
main().catch((e) => { console.error(e); process.exit(1); });
