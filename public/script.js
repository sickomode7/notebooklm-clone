let currentCollectionName = null;

// DOM Elements
const fileInput = document.getElementById('file-input');
const fileNameDisplay = document.getElementById('file-name');
const uploadBtn = document.getElementById('upload-btn');
const uploadStatus = document.getElementById('upload-status');
const uploadSection = document.getElementById('upload-section');
const uploadArea = document.getElementById('upload-area');

const chatSection = document.getElementById('chat-section');
const chatHistory = document.getElementById('chat-history');
const questionInput = document.getElementById('question-input');
const sendBtn = document.getElementById('send-btn');

// --- Upload Logic ---

// Handle drag and drop
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    uploadArea.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
    uploadArea.addEventListener(eventName, () => uploadArea.style.borderColor = 'var(--primary)', false);
});

['dragleave', 'drop'].forEach(eventName => {
    uploadArea.addEventListener(eventName, () => uploadArea.style.borderColor = '', false);
});

uploadArea.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    
    if (files.length > 0) {
        fileInput.files = files;
        handleFileSelect();
    }
});

fileInput.addEventListener('change', handleFileSelect);

function handleFileSelect() {
    if (fileInput.files.length > 0) {
        fileNameDisplay.textContent = fileInput.files[0].name;
        uploadBtn.disabled = false;
    } else {
        fileNameDisplay.textContent = '';
        uploadBtn.disabled = true;
    }
}

uploadBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('document', file);

    uploadBtn.disabled = true;
    fileInput.disabled = true;
    uploadStatus.textContent = 'Uploading and indexing document...';
    uploadStatus.className = 'status-message loading';

    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        
        if (response.ok && data.success) {
            currentCollectionName = data.collectionName;
            uploadStatus.textContent = `Success! Indexed ${data.chunksIndexed} chunks.`;
            uploadStatus.className = 'status-message success';
            
            // Transition to chat UI
            setTimeout(() => {
                uploadSection.style.display = 'none';
                chatSection.classList.remove('hidden');
                
                // Allow display:none to apply before adding visible class for animation
                requestAnimationFrame(() => {
                    chatSection.classList.add('visible');
                    questionInput.focus();
                });
            }, 1000);
            
        } else {
            throw new Error(data.error || 'Failed to upload document');
        }
    } catch (error) {
        uploadStatus.textContent = `Error: ${error.message}`;
        uploadStatus.className = 'status-message error';
        uploadBtn.disabled = false;
        fileInput.disabled = false;
    }
});

// --- Chat Logic ---

questionInput.addEventListener('input', () => {
    sendBtn.disabled = questionInput.value.trim().length === 0;
});

questionInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !sendBtn.disabled) {
        sendQuestion();
    }
});

sendBtn.addEventListener('click', () => {
    if (!sendBtn.disabled) sendQuestion();
});

async function sendQuestion() {
    const question = questionInput.value.trim();
    if (!question || !currentCollectionName) return;

    // Add user message
    appendMessage('user', question);
    questionInput.value = '';
    sendBtn.disabled = true;

    // Add loading indicator
    const loadingId = appendLoading();

    try {
        const response = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: question,
                collectionName: currentCollectionName
            })
        });

        const data = await response.json();
        removeLoading(loadingId);

        if (response.ok && data.answer) {
            appendMessage('assistant', data.answer, data.sources);
        } else {
            throw new Error(data.error || 'Failed to get answer');
        }
    } catch (error) {
        removeLoading(loadingId);
        appendMessage('assistant', `Error: ${error.message}`);
    }
    
    // Re-evaluate send button state
    sendBtn.disabled = questionInput.value.trim().length === 0;
    questionInput.focus();
}

function appendMessage(role, text, sources = null) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.textContent = text;
    
    msgDiv.appendChild(contentDiv);

    if (sources && sources.length > 0) {
        const sourcesDiv = document.createElement('div');
        sourcesDiv.className = 'message-sources';
        sourcesDiv.textContent = `Sources: chunk #${sources.join(', #')}`;
        msgDiv.appendChild(sourcesDiv);
    }

    chatHistory.appendChild(msgDiv);
    scrollToBottom();
}

function appendLoading() {
    const id = 'loading-' + Date.now();
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message assistant';
    msgDiv.id = id;
    
    msgDiv.innerHTML = `
        <div class="message-content">
            <div class="spinner">
                <div class="bounce1"></div>
                <div class="bounce2"></div>
                <div class="bounce3"></div>
            </div>
        </div>
    `;
    
    chatHistory.appendChild(msgDiv);
    scrollToBottom();
    return id;
}

function removeLoading(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

function scrollToBottom() {
    chatHistory.scrollTop = chatHistory.scrollHeight;
}
