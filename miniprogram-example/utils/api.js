// 复制到小程序 utils/api.js，并把 BASE 改成你的域名/IP
// 注意：小程序正式版要求 HTTPS 域名，且域名要在微信后台 -> 开发管理 -> 服务器域名里配置 request 合法域名
const BASE = 'https://你的域名:3000'; // 本地联调可用 http://你的NAS局域网IP:3000（需在开发工具勾选“不校验合法域名”）

function request(path, method = 'GET', data) {
  const token = wx.getStorageSync('token') || '';
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE + path,
      method,
      data,
      header: { Authorization: token ? 'Bearer ' + token : '' },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else reject(res.data);
      },
      fail: reject,
    });
  });
}

async function login() {
  const { code } = await wx.login();
  const res = await request('/api/auth/login', 'POST', { code });
  wx.setStorageSync('token', res.token);
  return res.user;
}

// 通用数据示例：原来 wx.cloud.database().collection('notes') 的增删改查，对应下面这样写
const db = {
  add: (collection, data) => request(`/api/data/${collection}`, 'POST', data),
  list: (collection, page = 1) => request(`/api/data/${collection}?page=${page}&pageSize=20`),
  update: (collection, id, data) => request(`/api/data/${collection}/${id}`, 'PUT', data),
  remove: (collection, id) => request(`/api/data/${collection}/${id}`, 'DELETE'),
};

function uploadFile(filePath) {
  const token = wx.getStorageSync('token') || '';
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: BASE + '/api/upload',
      filePath,
      name: 'file',
      header: { Authorization: 'Bearer ' + token },
      success: (res) => resolve(JSON.parse(res.data)),
      fail: reject,
    });
  });
}

module.exports = { login, request, db, uploadFile };
