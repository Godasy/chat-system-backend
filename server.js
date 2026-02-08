require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const expressIp = require('express-ip');

// 初始化Express
const app = express();
const server = createServer(app);

// 配置CORS（允许前端域名访问）
app.use(cors({
  origin: ['https://lmx.is-best.net', 'http://localhost:8080'], // 本地测试+线上前端
  credentials: true
}));
app.use(express.json());
app.use(expressIp().getIpInfoMiddleware); // 获取用户IP

// 初始化Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // 管理员权限，确保数据操作无限制
);

// 初始化Socket.io（实时通信核心）
const io = new Server(server, {
  cors: {
    origin: ['https://lmx.is-best.net', 'http://localhost:8080'],
    methods: ["GET", "POST"]
  }
});

// 自动唤醒Render（防止休眠）
setInterval(() => {
  axios.get(process.env.RENDER_URL)
    .catch(err => console.log('唤醒Render失败：', err.message));
}, 14 * 60 * 1000); // 每14分钟请求一次（Render免费版15分钟休眠）

// --------------- 核心API接口 ---------------
// 1. 用户注册/登录（首次输入名字，后续免登录）
app.post('/api/register', async (req, res) => {
  try {
    const { username } = req.body;
    const ip = req.ipInfo.ip;
    const location = `${req.ipInfo.city || '未知城市'}, ${req.ipInfo.country || '未知国家'}`;

    // 检查用户是否已存在
    const { data: existingUser } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    if (existingUser) {
      return res.json({ success: true, user: existingUser });
    }

    // 创建新用户
    const { data: newUser, error } = await supabase
      .from('users')
      .insert([
        { username, ip_address: ip, location: location }
      ])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, user: newUser });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// 2. 管理员认证
app.post('/api/admin/login', async (req, res) => {
  try {
    const { password, userId } = req.body;
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.json({ success: false, message: '管理员密码错误' });
    }

    // 将用户标记为管理员
    const { data: user, error } = await supabase
      .from('users')
      .update({ is_admin: true })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, user });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// 3. 管理员功能：获取所有用户
app.get('/api/admin/users', async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('*');

    if (error) throw error;
    res.json({ success: true, users });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// 4. 管理员功能：添加黑名单
app.post('/api/admin/blacklist', async (req, res) => {
  try {
    const { userId, reason } = req.body;
    const { data: user, error } = await supabase
      .from('users')
      .update({ 
        is_blacklisted: true,
        blacklist_reason: reason 
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    // 通知被拉黑的用户
    io.to(userId).emit('blacklisted', { reason });
    res.json({ success: true, user });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// 5. 上传图片（设置1天过期）
app.post('/api/upload/image', async (req, res) => {
  try {
    const { base64Image, userId } = req.body;
    // 将base64转为Buffer
    const buffer = Buffer.from(base64Image.split(',')[1], 'base64');
    const fileName = `${uuidv4()}.png`;
    const expireAt = new Date();
    expireAt.setDate(expireAt.getDate() + 1); // 1天后过期

    // 上传到Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase
      .storage
      .from('chat-images')
      .upload(fileName, buffer, {
        contentType: 'image/png',
        cacheControl: '3600'
      });

    if (uploadError) throw uploadError;

    // 获取图片公开URL
    const imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/chat-images/${fileName}`;

    res.json({ 
      success: true, 
      imageUrl, 
      expireAt: expireAt.toISOString() 
    });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// --------------- Socket.io 实时通信 ---------------
// 存储在线用户
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('用户连接：', socket.id);

  // 1. 用户上线
  socket.on('user-online', async (userId) => {
    onlineUsers.set(userId, socket.id);
    socket.join(userId); // 加入个人房间（用于私聊/黑名单通知）

    // 更新在线用户表
    await supabase
      .from('online_users')
      .upsert([{ user_id: userId, socket_id: socket.id }]);

    // 广播在线人数
    const { data: onlineData } = await supabase
      .from('online_users')
      .select('*');
    io.emit('online-count', onlineData.length);
  });

  // 2. 发送公聊消息
  socket.on('send-public-msg', async (msgData) => {
    // 检查用户是否被拉黑
    const { data: user } = await supabase
      .from('users')
      .select('is_blacklisted')
      .eq('id', msgData.senderId)
      .single();

    if (user?.is_blacklisted) {
      socket.emit('blacklisted', { reason: user.blacklist_reason });
      return;
    }

    // 保存消息到数据库
    const { data: newMsg, error } = await supabase
      .from('messages')
      .insert([{
        sender_id: msgData.senderId,
        content: msgData.content,
        image_url: msgData.imageUrl,
        image_expire_at: msgData.imageExpireAt,
        is_admin_msg: msgData.isAdminMsg
      }])
      .select()
      .single();

    if (error) {
      socket.emit('msg-error', error.message);
      return;
    }

    // 广播消息给所有人
    io.emit('new-public-msg', newMsg);
  });

  // 3. 发送私聊消息
  socket.on('send-private-msg', async (msgData) => {
    // 检查发送者是否被拉黑
    const { data: sender } = await supabase
      .from('users')
      .select('is_blacklisted')
      .eq('id', msgData.senderId)
      .single();

    if (sender?.is_blacklisted) {
      socket.emit('blacklisted', { reason: sender.blacklist_reason });
      return;
    }

    // 保存私聊消息
    const { data: newMsg, error } = await supabase
      .from('messages')
      .insert([{
        sender_id: msgData.senderId,
        receiver_id: msgData.receiverId,
        content: msgData.content,
        image_url: msgData.imageUrl,
        image_expire_at: msgData.imageExpireAt,
        is_admin_msg: msgData.isAdminMsg
      }])
      .select()
      .single();

    if (error) {
      socket.emit('msg-error', error.message);
      return;
    }

    // 发送给接收者
    const receiverSocketId = onlineUsers.get(msgData.receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('new-private-msg', newMsg);
    }
    // 发送给发送者自己
    socket.emit('new-private-msg', newMsg);
  });

  // 4. 添加好友到通讯录
  socket.on('add-contact', async (data) => {
    try {
      const { userId, friendId } = data;
      // 检查是否已添加
      const { data: existing } = await supabase
        .from('contacts')
        .select('*')
        .eq('user_id', userId)
        .eq('friend_id', friendId)
        .single();

      if (existing) {
        socket.emit('contact-added', { success: false, message: '已添加该好友' });
        return;
      }

      // 添加好友
      await supabase
        .from('contacts')
        .insert([{ user_id: userId, friend_id: friendId }]);

      socket.emit('contact-added', { success: true });
    } catch (error) {
      socket.emit('contact-added', { success: false, message: error.message });
    }
  });

  // 5. 删除好友
  socket.on('delete-contact', async (data) => {
    try {
      const { userId, friendId } = data;
      await supabase
        .from('contacts')
        .delete()
        .eq('user_id', userId)
        .eq('friend_id', friendId);

      socket.emit('contact-deleted', { success: true });
    } catch (error) {
      socket.emit('contact-deleted', { success: false, message: error.message });
    }
  });

  // 6. 获取历史消息
  socket.on('get-history-msgs', async (data) => {
    try {
      const { type, userId, friendId } = data;
      let query = supabase.from('messages').select('*, users(username, avatar)');
      
      // 公聊消息
      if (type === 'public') {
        query = query.is('receiver_id', null);
      }
      // 私聊消息
      else if (type === 'private') {
        query = query.or(`(sender_id.eq.${userId},receiver_id.eq.${friendId}), (sender_id.eq.${friendId},receiver_id.eq.${userId})`);
      }

      const { data: msgs, error } = await query.order('send_time', { ascending: true });
      if (error) throw error;
      socket.emit('history-msgs', msgs);
    } catch (error) {
      socket.emit('msg-error', error.message);
    }
  });

  // 7. 编辑个人信息
  socket.on('edit-profile', async (data) => {
    try {
      const { userId, avatar, bio } = data;
      const { data: user, error } = await supabase
        .from('users')
        .update({ avatar, bio })
        .eq('id', userId)
        .select()
        .single();

      if (error) throw error;
      socket.emit('profile-updated', user);
    } catch (error) {
      socket.emit('profile-error', error.message);
    }
  });

  // 用户断开连接
  socket.on('disconnect', async () => {
    // 移除在线用户
    for (const [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userId);
        // 更新数据库
        await supabase
          .from('online_users')
          .delete()
          .eq('user_id', userId);
        
        // 广播在线人数
        const { data: onlineData } = await supabase
          .from('online_users')
          .select('*');
        io.emit('online-count', onlineData.length);
        break;
      }
    }
    console.log('用户断开连接：', socket.id);
  });
});

// 健康检查接口（Render唤醒用）
app.get('/', (req, res) => {
  res.send('Chat backend is running!');
});

// 启动服务器
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`后端服务器运行在端口 ${PORT}`);
});