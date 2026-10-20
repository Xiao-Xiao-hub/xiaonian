/*
 * 独立对话页：承接卡片、头脑风暴和历史会话入口，复用 utils/chat-room 的会话逻辑。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
// 聊一聊 : chats that start from 随心记 (a jot, a card, a mood chat, a
// brainstorm) open here and come back. Nothing here is remembered as 解题's chat
// to reopen. The conversation itself is utils/chat-room.js, shared with the
// 聊一聊 tab.
const studyClock = require("../../utils/study-clock");
const room = require("../../utils/chat-room");

Page(studyClock.track(room()));
