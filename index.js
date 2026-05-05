//Server created by Ayaz 
// 15 16 digit convo id support 
const fs = require('fs');
const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 20025;

// Store active tasks - Persistent storage simulation
const TASKS_FILE = 'active_tasks.json';
const COOKIES_DIR = 'cookies';

// Ensure directories exist
if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
}

// Load persistent tasks
function loadTasks() {
    try {
        if (fs.existsSync(TASKS_FILE)) {
            const data = fs.readFileSync(TASKS_FILE, 'utf8');
            const tasksData = JSON.parse(data);
            const tasks = new Map();

            for (let [taskId, taskData] of Object.entries(tasksData)) {
                const task = new Task(taskId, taskData.userData);
                task.config = taskData.config;
                task.messageData = taskData.messageData;
                task.stats = taskData.stats;
                task.logs = taskData.logs || [];
                task.config.running = true;
                tasks.set(taskId, task);

                console.log(" Reloaded persistent task: " + taskId);

                setTimeout(() => {
                    if (task.config.running) {
                        task.start();
                    }
                }, 5000);
            }

            return tasks;
        }
    } catch (error) {
        console.error('Error loading tasks:', error);
    }
    return new Map();
}

// Save tasks persistently
function saveTasks() {
    try {
        const tasksData = {};
        for (let [taskId, task] of activeTasks.entries()) {
            if (task.config.running) {
                tasksData[taskId] = {
                    userData: task.userData,
                    config: { ...task.config, api: null },
                    messageData: task.messageData,
                    stats: task.stats,
                    logs: task.logs.slice(0, 50)
                };
            }
        }
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasksData, null, 2));
    } catch (error) {
        console.error('Error saving tasks:', error);
    }
}

setInterval(saveTasks, 30000);

function setupAutoRestart() {
    setInterval(() => {
        for (let [taskId, task] of activeTasks.entries()) {
            if (task.config.running && !task.healthCheck()) {
                console.log(" Auto-restarting stuck task: " + taskId);
                task.restart();
            }
        }
    }, 60000);
}

let activeTasks = loadTasks();

class Task {
    constructor(taskId, userData) {
        this.taskId = taskId;
        this.userData = userData;
        this.config = {
            delay: userData.delay || 5,
            running: false,
            api: null,
            lastActivity: Date.now(),
            restartCount: 0,
            maxRestarts: 1000
        };
        this.messageData = {
            threadID: userData.threadID,
            messages: [],
            currentIndex: 0,
            loopCount: 0
        };
        this.stats = {
            sent: 0,
            failed: 0,
            activeCookies: 0,
            loops: 0,
            restarts: 0,
            lastSuccess: null
        };
        this.logs = [];
        this.retryCount = 0;
        this.maxRetries = 50;
        this.initializeMessages(userData.messageContent, userData.hatersName, userData.lastHereName);
    }

    initializeMessages(messageContent, hatersName, lastHereName) {
        this.messageData.messages = messageContent
            .split('\n')
            .map(line => line.replace(/\r/g, '').trim())
            .filter(line => line.length > 0)
            .map(message => hatersName + " " + message + " " + lastHereName);

        this.addLog("Loaded " + this.messageData.messages.length + " formatted messages");
    }

    addLog(message, messageType = 'info') {
        const logEntry = {
            time: new Date().toLocaleTimeString('en-IN'),
            message: message,
            type: messageType
        };
        this.logs.unshift(logEntry);
        if (this.logs.length > 100) {
            this.logs = this.logs.slice(0, 100);
        }

        this.config.lastActivity = Date.now();
        broadcastToTask(this.taskId, {
            type: 'log',
            message: message,
            messageType: messageType
        });
    }

    healthCheck() {
        return Date.now() - this.config.lastActivity < 300000;
    }

    async start() {
        if (this.config.running) {
            this.addLog('Task is already running', 'info');
            return true;
        }

        this.config.running = true;
        this.retryCount = 0;

        try {
            const cookiePath = COOKIES_DIR + "/cookie_" + this.taskId + ".txt";
            fs.writeFileSync(cookiePath, this.userData.cookieContent);
            this.addLog('Cookie content saved', 'success');
        } catch (err) {
            this.addLog("Failed to save cookie: " + err.message, 'error');
            this.config.running = false;
            return false;
        }

        if (this.messageData.messages.length === 0) {
            this.addLog('No messages found in the file', 'error');
            this.config.running = false;
            return false;
        }

        this.addLog("Starting task with " + this.messageData.messages.length + " messages");

        return this.initializeBot();
    }

    initializeBot() {
        return new Promise((resolve) => {
            wiegine.login(this.userData.cookieContent, {
                logLevel: "silent",
                forceLogin: true,
                selfListen: false
            }, (err, api) => {
                if (err || !api) {
                    this.addLog("Login failed: " + (err ? err.message : 'Unknown error'), 'error');

                    if (this.retryCount < this.maxRetries) {
                        this.retryCount++;
                        this.addLog("Auto-retry login attempt " + this.retryCount + "/" + this.maxRetries + " in 30 seconds...", 'info');

                        setTimeout(() => {
                            this.initializeBot();
                        }, 30000);
                    } else {
                        this.addLog('Max login retries reached. Task paused.', 'error');
                        this.config.running = false;
                    }

                    resolve(false);
                    return;
                }

                this.config.api = api;
                this.stats.activeCookies = 1;
                this.retryCount = 0;
                this.addLog('Logged in successfully', 'success');

                this.getGroupInfo(api, this.messageData.threadID);
                this.sendNextMessage(api);
                resolve(true);
            });
        });
    }

    getGroupInfo(api, threadID) {
        try {
            if (api && typeof api.getThreadInfo === 'function') {
                api.getThreadInfo(threadID, (err, info) => {
                    if (!err && info) {
                        this.addLog("Target: " + (info.name || 'Unknown') + " (ID: " + threadID + ")", 'info');
                    }
                });
            }
        } catch (e) {}
    }

    sendNextMessage(api) {
        if (!this.config.running || !api) {
            return;
        }

        if (this.messageData.currentIndex >= this.messageData.messages.length) {
            this.messageData.loopCount++;
            this.stats.loops = this.messageData.loopCount;
            this.addLog("Loop #" + this.messageData.loopCount + " completed. Restarting.", 'info');
            this.messageData.currentIndex = 0;
        }

        const message = this.messageData.messages[this.messageData.currentIndex];
        const currentIndex = this.messageData.currentIndex;
        const totalMessages = this.messageData.messages.length;

        this.sendMessageWithRetry(api, message, currentIndex, totalMessages);
    }

    sendMessageWithRetry(api, message, currentIndex, totalMessages, retryAttempt = 0) {
        if (!this.config.running) return;

        const maxSendRetries = 10;

        try {
            api.sendMessage(message, this.messageData.threadID, (err) => {
                const timestamp = new Date().toLocaleTimeString('en-IN');

                if (err) {
                    this.stats.failed++;

                    // 15-digit chat ID check
                    const threadID = this.messageData.threadID;
                    const is15DigitChat = /^\d{15}$/.test(threadID);

                    if (is15DigitChat) {
                        this.addLog(" 15-digit chat ID detected. Trying alternative...", 'warning');
                        this.sendTo15DigitChat(api, message, threadID, currentIndex, totalMessages, retryAttempt);
                        return;
                    }

                    if (retryAttempt < maxSendRetries) {
                        this.addLog(" RETRY " + (retryAttempt + 1) + "/" + maxSendRetries + " | Message " + (currentIndex + 1) + "/" + totalMessages, 'info');

                        setTimeout(() => {
                            this.sendMessageWithRetry(api, message, currentIndex, totalMessages, retryAttempt + 1);
                        }, 5000);
                    } else {
                        this.addLog(" FAILED after " + maxSendRetries + " retries | Message " + (currentIndex + 1) + "/" + totalMessages, 'error');
                        this.messageData.currentIndex++;
                        this.scheduleNextMessage(api);
                    }
                } else {
                    this.stats.sent++;
                    this.stats.lastSuccess = Date.now();
                    this.retryCount = 0;
                    this.addLog(" SENT | " + timestamp + " | Message " + (currentIndex + 1) + "/" + totalMessages + " | Loop " + (this.messageData.loopCount + 1), 'success');

                    this.messageData.currentIndex++;
                    this.scheduleNextMessage(api);
                }
            });
        } catch (sendError) {
            this.addLog(" CRITICAL: Send error - restarting bot", 'error');
            this.restart();
        }
    }

    sendTo15DigitChat(api, message, threadID, currentIndex, totalMessages, retryAttempt = 0) {
        const max15DigitRetries = 5;

        try {
            if (api && typeof api.sendMessage === 'function') {
                api.sendMessage({
                    body: message
                }, threadID, (err) => {
                    if (err) {
                        const numericThreadID = parseInt(threadID);
                        api.sendMessage(message, numericThreadID, (err2) => {
                            if (err2) {
                                if (retryAttempt < max15DigitRetries) {
                                    this.addLog(" 15-digit retry " + (retryAttempt + 1) + "/" + max15DigitRetries + "...", 'info');
                                    setTimeout(() => {
                                        this.sendTo15DigitChat(api, message, threadID, currentIndex, totalMessages, retryAttempt + 1);
                                    }, 3000);
                                } else {
                                    this.addLog(" Failed to send to 15-digit chat", 'error');
                                    this.messageData.currentIndex++;
                                    this.scheduleNextMessage(api);
                                }
                            } else {
                                this.stats.sent++;
                                this.stats.lastSuccess = Date.now();
                                this.addLog(" SENT to 15-digit chat | Message " + (currentIndex + 1) + "/" + totalMessages, 'success');
                                this.messageData.currentIndex++;
                                this.scheduleNextMessage(api);
                            }
                        });
                    } else {
                        this.stats.sent++;
                        this.stats.lastSuccess = Date.now();
                        this.addLog(" SENT to 15-digit chat | Message " + (currentIndex + 1) + "/" + totalMessages, 'success');
                        this.messageData.currentIndex++;
                        this.scheduleNextMessage(api);
                    }
                });
            }
        } catch (error) {
            if (retryAttempt < max15DigitRetries) {
                setTimeout(() => {
                    this.sendTo15DigitChat(api, message, threadID, currentIndex, totalMessages, retryAttempt + 1);
                }, 3000);
            } else {
                this.addLog(" 15-digit chat send failed", 'error');
                this.messageData.currentIndex++;
                this.scheduleNextMessage(api);
            }
        }
    }

    scheduleNextMessage(api) {
        if (!this.config.running) return;

        setTimeout(() => {
            try {
                this.sendNextMessage(api);
            } catch (e) {
                this.addLog(" Error in message scheduler", 'error');
                this.restart();
            }
        }, this.config.delay * 1000);
    }

    restart() {
        this.addLog(' RESTARTING TASK...', 'info');
        this.stats.restarts++;
        this.config.restartCount++;

        if (this.config.api) {
            this.config.api = null;
        }

        this.stats.activeCookies = 0;

        setTimeout(() => {
            if (this.config.running && this.config.restartCount <= this.config.maxRestarts) {
                this.initializeBot();
            } else if (this.config.restartCount > this.config.maxRestarts) {
                this.addLog(' MAX RESTARTS REACHED - Task stopped', 'error');
                this.config.running = false;
            }
        }, 10000);
    }

    stop() {
        console.log(" Stopping task: " + this.taskId);
        this.config.running = false;

        this.stats.activeCookies = 0;
        this.addLog(' Task stopped by user - ID remains logged in', 'info');
        this.addLog(' You can use same cookies again without relogin', 'info');

        try {
            const cookiePath = COOKIES_DIR + "/cookie_" + this.taskId + ".txt";
            if (fs.existsSync(cookiePath)) {
                fs.unlinkSync(cookiePath);
            }
        } catch (e) {}

        saveTasks();
        return true;
    }

    getDetails() {
        return {
            taskId: this.taskId,
            sent: this.stats.sent,
            failed: this.stats.failed,
            activeCookies: this.stats.activeCookies,
            loops: this.stats.loops,
            restarts: this.stats.restarts,
            logs: this.logs,
            running: this.config.running,
            uptime: this.config.lastActivity ? Date.now() - this.config.lastActivity : 0
        };
    }
}

process.on('uncaughtException', (error) => {
    console.log('Global error handler caught exception:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.log('Global handler caught rejection at:', promise, 'reason:', reason);
});

function broadcastToTask(taskId, message) {
    if (!wss) return;

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.taskId === taskId) {
            try {
                client.send(JSON.stringify(message));
            } catch (e) {}
        }
    });
}

// HTML Control Panel - SURAJ COOKIES SERVER
const htmlControlPanel = `<!DOCTYPE html>
<html>
<head>
    <title>SURAJ COOKIES SERVER</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: Arial, sans-serif; }
        body { background: #0a0a1a; color: white; min-height: 100vh; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        .header { background: linear-gradient(90deg, #ff3366, #3366ff); padding: 20px; border-radius: 10px; text-align: center; margin-bottom: 20px; }
        .card { background: rgba(255,255,255,0.1); padding: 20px; border-radius: 10px; margin-bottom: 20px; border: 1px solid rgba(255,255,255,0.1); }
        .upload-box { background: rgba(0,0,0,0.3); padding: 15px; border-radius: 8px; margin: 10px 0; border: 2px dashed rgba(255,255,255,0.2); }
        input, button { width: 100%; padding: 12px; margin: 8px 0; border-radius: 5px; border: 1px solid #444; background: #222; color: white; }
        button { background: #3366ff; border: none; cursor: pointer; font-weight: bold; }
        button:hover { background: #ff3366; }
        .start-btn { background: linear-gradient(135deg, #00b894, #00a085); }
        .stop-btn { background: linear-gradient(135deg, #ff7675, #e66767); }
        .view-btn { background: linear-gradient(135deg, #74b9ff, #0984e3); }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); align-items: center; justify-content: center; z-index: 1000; }
        .modal-content { background: #1a1a3e; padding: 30px; border-radius: 10px; max-width: 500px; width: 90%; position: relative; }
        .modal-close { position: absolute; top: 10px; right: 15px; font-size: 28px; cursor: pointer; color: #ff3366; }
        .modal-close:hover { color: #ff0066; }
        .task-id { background: rgba(0,0,0,0.5); padding: 15px; border-radius: 5px; margin: 15px 0; font-family: monospace; word-break: break-all; }
        .modal-buttons { display: flex; gap: 10px; margin-top: 20px; }
        .close-btn { background: linear-gradient(135deg, #666, #444); }
        .close-btn:hover { background: linear-gradient(135deg, #888, #666); }
    </style>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><i class="fas fa-rocket"></i> SURAJ COOKIES SERVER</h1>
            <p>All Type : Convo id Supported</p>
        </div>

        <div class="card">
            <h2><i class="fas fa-file-upload"></i> Upload Files</h2>
            <div class="upload-box">
                <h3><i class="fas fa-cookie-bite"></i> Upload Cookies File</h3>
                <input type="file" id="cookieFile" accept=".txt">
            </div>
            <div class="upload-box">
                <h3><i class="fas fa-comment-alt"></i> Upload Message File</h3>
                <input type="file" id="messageFile" accept=".txt">
            </div>
        </div>

        <div class="card">
            <h2><i class="fas fa-cogs"></i> Configuration</h2>
            <input type="text" id="hatersName" placeholder="Hater's Name">
            <input type="text" id="lastHereName" placeholder="Last Here Name">
            <input type="text" id="threadId" placeholder="Thread/Group ID">
            <input type="number" id="delay" value="5" placeholder="Delay (Seconds)">
            
            <button class="start-btn" onclick="startTask()"><i class="fas fa-play-circle"></i> START AUTOMATION</button>
            <button class="stop-btn" onclick="openStopModal()"><i class="fas fa-stop-circle"></i> STOP TASK</button>
            <button class="view-btn" onclick="openViewModal()"><i class="fas fa-eye"></i> VIEW MY TASK STATUS</button>
        </div>

        <div class="card">
            <h2><i class="fas fa-chart-line"></i> Live Status</h2>
            <div id="statusGrid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;">
                <div style="background: rgba(0,0,0,0.3); padding: 15px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 24px; font-weight: bold; color: #4dabf7;" id="activeTasks">0</div>
                    <div style="font-size: 12px; color: #adb5bd;">Active Tasks</div>
                </div>
                <div style="background: rgba(0,0,0,0.3); padding: 15px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 24px; font-weight: bold; color: #00b894;" id="totalSent">0</div>
                    <div style="font-size: 12px; color: #adb5bd;">Total Sent</div>
                </div>
            </div>
        </div>
    </div>

    <!-- Task Created Modal -->
    <div class="modal" id="taskIdModal">
        <div class="modal-content">
            <span class="modal-close" onclick="closeTaskIdModal()">×</span>
            <h3><i class="fas fa-id-card"></i> Task Created!</h3>
            <p>Your task has been started successfully!</p>
            <div class="task-id" id="generatedTaskId">Loading...</div>
            <div class="modal-buttons">
                <button onclick="copyTaskId()" style="background: #4dabf7;"><i class="fas fa-copy"></i> Copy Task ID</button>
                <button class="close-btn" onclick="closeTaskIdModal()"><i class="fas fa-times"></i> Close Window</button>
            </div>
        </div>
    </div>

    <!-- Stop Task Modal -->
    <div class="modal" id="stopModal">
        <div class="modal-content">
            <span class="modal-close" onclick="closeStopModal()">×</span>
            <h3><i class="fas fa-stop-circle"></i> Stop Task</h3>
            <p>Enter your Task ID to stop:</p>
            <input type="text" id="stopTaskId" placeholder="Paste Task ID">
            <div id="stopMessage" style="display: none; margin-top: 10px; padding: 10px; border-radius: 5px;"></div>
            <div class="modal-buttons">
                <button class="stop-btn" onclick="stopTask()"><i class="fas fa-ban"></i> Stop Task</button>
                <button class="close-btn" onclick="closeStopModal()"><i class="fas fa-times"></i> Close Window</button>
            </div>
        </div>
    </div>

    <!-- View Task Modal -->
    <div class="modal" id="viewModal">
        <div class="modal-content">
            <span class="modal-close" onclick="closeViewModal()">×</span>
            <h3><i class="fas fa-eye"></i> View My Task Status</h3>
            <p>Enter your Task ID to view details:</p>
            <input type="text" id="viewTaskId" placeholder="Paste Task ID">
            <div id="taskDetails" style="margin-top: 20px; display: none;"></div>
            <div class="modal-buttons">
                <button class="view-btn" onclick="viewTask()"><i class="fas fa-search"></i> View Details</button>
                <button class="close-btn" onclick="closeViewModal()"><i class="fas fa-times"></i> Close Window</button>
            </div>
        </div>
    </div>

    <script>
        let ws = new WebSocket((window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host);
        let currentTaskId = null;
        
        ws.onopen = function() {
            console.log('Connected to server');
        };
        
        ws.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'task_started') {
                    currentTaskId = data.taskId;
                    document.getElementById('generatedTaskId').textContent = data.taskId;
                    document.getElementById('taskIdModal').style.display = 'flex';
                }
                else if (data.type === 'task_stopped') {
                    document.getElementById('stopMessage').innerHTML = '<div style="background: rgba(0,184,148,0.2); color: #00b894; padding: 10px; border-radius: 5px;">Task stopped successfully!</div>';
                    document.getElementById('stopMessage').style.display = 'block';
                    setTimeout(() => {
                        closeStopModal();
                    }, 2000);
                }
                else if (data.type === 'task_details') {
                    displayTaskDetails(data);
                }
                else if (data.type === 'task_not_found') {
                    document.getElementById('taskDetails').innerHTML = '<div style="background: rgba(255,118,117,0.2); color: #ff7675; padding: 10px; border-radius: 5px;">Task not found!</div>';
                    document.getElementById('taskDetails').style.display = 'block';
                }
                else if (data.type === 'server_status') {
                    document.getElementById('activeTasks').textContent = data.activeTasks;
                    document.getElementById('totalSent').textContent = data.totalSent;
                }
                
            } catch (err) {
                console.error('Error:', err);
            }
        };
        
        function startTask() {
            const cookieFile = document.getElementById('cookieFile').files[0];
            const messageFile = document.getElementById('messageFile').files[0];
            const hatersName = document.getElementById('hatersName').value;
            const lastHereName = document.getElementById('lastHereName').value;
            const threadId = document.getElementById('threadId').value;
            const delay = document.getElementById('delay').value;
            
            if (!cookieFile || !messageFile) {
                alert('Please upload both files');
                return;
            }
            
            const reader = new FileReader();
            reader.onload = function(e) {
                const messageContent = e.target.result;
                const cookieReader = new FileReader();
                cookieReader.onload = function(e) {
                    const cookieContent = e.target.result;
                    ws.send(JSON.stringify({
                        type: 'start',
                        cookieContent: cookieContent,
                        messageContent: messageContent,
                        hatersName: hatersName,
                        threadID: threadId,
                        lastHereName: lastHereName,
                        delay: parseInt(delay) || 5
                    }));
                };
                cookieReader.readAsText(cookieFile);
            };
            reader.readAsText(messageFile);
        }
        
        function openStopModal() {
            document.getElementById('stopModal').style.display = 'flex';
            document.getElementById('stopTaskId').value = '';
            document.getElementById('stopMessage').style.display = 'none';
        }
        
        function closeStopModal() {
            document.getElementById('stopModal').style.display = 'none';
        }
        
        function stopTask() {
            const taskId = document.getElementById('stopTaskId').value.trim();
            if (!taskId) {
                alert('Please enter Task ID');
                return;
            }
            ws.send(JSON.stringify({ type: 'stop', taskId: taskId }));
        }
        
        function openViewModal() {
            document.getElementById('viewModal').style.display = 'flex';
            document.getElementById('viewTaskId').value = '';
            document.getElementById('taskDetails').style.display = 'none';
        }
        
        function closeViewModal() {
            document.getElementById('viewModal').style.display = 'none';
        }
        
        function viewTask() {
            const taskId = document.getElementById('viewTaskId').value.trim();
            if (!taskId) {
                alert('Please enter Task ID');
                return;
            }
            ws.send(JSON.stringify({ type: 'view', taskId: taskId }));
        }
        
        function closeTaskIdModal() {
            document.getElementById('taskIdModal').style.display = 'none';
        }
        
        function copyTaskId() {
            const taskId = document.getElementById('generatedTaskId').textContent;
            navigator.clipboard.writeText(taskId);
            alert('Task ID copied to clipboard!');
        }
        
        function displayTaskDetails(data) {
            const details = data.details;
            let html = '<h4>Task Details:</h4>';
            html += '<div style="background: rgba(0,0,0,0.3); padding: 15px; border-radius: 8px;">';
            html += '<p><strong>Status:</strong> ' + (details.running ? ' Running' : ' Stopped') + '</p>';
            html += '<p><strong>Messages Sent:</strong> ' + details.sent + '</p>';
            html += '<p><strong>Messages Failed:</strong> ' + details.failed + '</p>';
            html += '<p><strong>Loops Completed:</strong> ' + details.loops + '</p>';
            html += '<p><strong>Restarts:</strong> ' + details.restarts + '</p>';
            html += '<p><strong>Active Cookies:</strong> ' + details.activeCookies + '</p>';
            html += '</div>';
            
            // Add recent logs if available
            if (details.logs && details.logs.length > 0) {
                html += '<h4 style="margin-top: 15px;">Recent Logs:</h4>';
                html += '<div style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px; max-height: 200px; overflow-y: auto;">';
                details.logs.slice(0, 5).forEach(log => {
                    const color = log.type === 'success' ? '#00b894' : 
                                  log.type === 'error' ? '#ff7675' : 
                                  log.type === 'warning' ? '#fdcb6e' : '#74b9ff';
                    html += \`<div style="border-left: 3px solid \${color}; padding-left: 10px; margin: 5px 0;">
                        <small style="color: #aaa;">\${log.time}</small>
                        <div>\${log.message}</div>
                    </div>\`;
                });
                html += '</div>';
            }
            
            document.getElementById('taskDetails').innerHTML = html;
            document.getElementById('taskDetails').style.display = 'block';
        }
        
        // Close modal when clicking outside
        window.onclick = function(event) {
            if (event.target.classList.contains('modal')) {
                event.target.style.display = 'none';
            }
        }
        
        // Request status every 5 seconds
        setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'get_status' }));
            }
        }, 5000);
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.send(htmlControlPanel);
});

let server;
let wss;

try {
    server = app.listen(PORT, () => {
        console.log(" AYAZ COOKIES SERVER running at http://localhost:" + PORT);
        console.log(" Auto-Recovery: ACTIVE");
        console.log(" 15-digit Chat Support: ENABLED");
    });

    wss = new WebSocket.Server({ server });

    wss.on('connection', (ws) => {
        ws.taskId = null;

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                if (data.type === 'start') {
                    const taskId = uuidv4();
                    ws.taskId = taskId;

                    const task = new Task(taskId, {
                        cookieContent: data.cookieContent,
                        messageContent: data.messageContent,
                        hatersName: data.hatersName,
                        threadID: data.threadID,
                        lastHereName: data.lastHereName,
                        delay: data.delay
                    });

                    if (task.start()) {
                        activeTasks.set(taskId, task);
                        ws.send(JSON.stringify({
                            type: 'task_started',
                            taskId: taskId
                        }));
                        console.log(" New task started: " + taskId);
                        saveTasks();
                    }
                }
                else if (data.type === 'stop') {
                    const taskId = data.taskId;
                    const task = activeTasks.get(taskId);
                    
                    if (task && task.config.running) {
                        task.stop();
                        activeTasks.delete(taskId);
                        ws.send(JSON.stringify({
                            type: 'task_stopped',
                            taskId: taskId
                        }));
                        console.log(" Task stopped: " + taskId);
                    } else {
                        ws.send(JSON.stringify({
                            type: 'task_not_found',
                            taskId: taskId
                        }));
                    }
                }
                else if (data.type === 'view') {
                    const taskId = data.taskId;
                    const task = activeTasks.get(taskId);
                    
                    if (task) {
                        ws.send(JSON.stringify({
                            type: 'task_details',
                            taskId: taskId,
                            details: task.getDetails()
                        }));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'task_not_found',
                            taskId: taskId
                        }));
                    }
                }
                else if (data.type === 'get_status') {
                    const activeTaskCount = Array.from(activeTasks.values()).filter(t => t.config.running).length;
                    const totalSent = Array.from(activeTasks.values()).reduce((sum, t) => sum + t.stats.sent, 0);
                    
                    ws.send(JSON.stringify({
                        type: 'server_status',
                        activeTasks: activeTaskCount,
                        totalSent: totalSent,
                        serverUptime: process.uptime()
                    }));
                }
                
            } catch (err) {
                console.error('WebSocket error:', err);
            }
        });
    });

    setupAutoRestart();

} catch (error) {
    console.error("Server startup error:", error);
}

process.on('SIGINT', () => {
    saveTasks();
    if (server) {
        server.close();
    }
    process.exit(0);
});