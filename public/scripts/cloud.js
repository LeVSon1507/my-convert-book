    // ===== FIREBASE CLOUD SYNC (Firestore only — Spark free plan) =====
    // Text is split into 600K-char chunks stored in subcollection to stay under 1MB/doc limit.
    const FIRESTORE_CHUNK_SIZE = 600000;
    const CLOUD_PROGRESS_PREFIX = 'progress_';

    let _fbAuth = null;
    let _fbDb = null;
    let lastCloudProgressSavedAt = 0;

    function initFirebase() {
      const config = globalThis.FIREBASE_CONFIG;
      if (!config || typeof firebase === 'undefined') { updateAuthUI(); return; }
      try {
        if (!firebase.apps.length) firebase.initializeApp(config);
        _fbAuth = firebase.auth();
        _fbDb = firebase.firestore();
        _fbAuth.onAuthStateChanged(function(user) {
          currentFirebaseUser = user;
          updateAuthUI();
          if (user) loadCloudHistory();
          else { cloudHistory = []; renderTranslationHistory(); }
        });
      } catch (e) {
        console.warn('Firebase init error:', e.message);
        updateAuthUI();
      }
    }

    async function cloudLogin() {
      const errEl = document.getElementById('authError');
      if (!_fbAuth) {
        if (errEl) errEl.textContent = 'Firebase chưa được khởi tạo. Tải lại trang và thử lại.';
        return;
      }
      const email = document.getElementById('authEmail').value.trim();
      const password = document.getElementById('authPassword').value;
      errEl.textContent = '';
      if (!email || !password) { errEl.textContent = 'Nhập email và mật khẩu.'; return; }
      const btn = document.getElementById('loginBtn');
      btn.disabled = true;
      try {
        await _fbAuth.signInWithEmailAndPassword(email, password);
      } catch (e) {
        errEl.textContent = firebaseAuthMsg(e.code);
      } finally {
        btn.disabled = false;
      }
    }

    async function cloudRegister() {
      if (!_fbAuth) return;
      const email = document.getElementById('authEmail').value.trim();
      const password = document.getElementById('authPassword').value;
      const errEl = document.getElementById('authError');
      errEl.textContent = '';
      if (!email || !password) { errEl.textContent = 'Nhập email và mật khẩu.'; return; }
      if (password.length < 6) { errEl.textContent = 'Mật khẩu ít nhất 6 ký tự.'; return; }
      const btn = document.getElementById('registerBtn');
      btn.disabled = true;
      try {
        await _fbAuth.createUserWithEmailAndPassword(email, password);
      } catch (e) {
        errEl.textContent = firebaseAuthMsg(e.code);
      } finally {
        btn.disabled = false;
      }
    }

    async function cloudLogout() {
      if (!_fbAuth) return;
      await _fbAuth.signOut();
    }

    function firebaseAuthMsg(code) {
      const m = {
        'auth/user-not-found': 'Email không tồn tại.',
        'auth/wrong-password': 'Mật khẩu không đúng.',
        'auth/invalid-credential': 'Email hoặc mật khẩu không đúng.',
        'auth/email-already-in-use': 'Email đã được sử dụng.',
        'auth/invalid-email': 'Email không hợp lệ.',
        'auth/weak-password': 'Mật khẩu quá yếu.',
        'auth/too-many-requests': 'Thử lại sau ít phút.',
      };
      return m[code] || ('Lỗi: ' + code);
    }

    function updateAuthUI() {
      const loginForm = document.getElementById('authLoginForm');
      const loggedInRow = document.getElementById('authLoggedIn');
      if (!loginForm) return;
      if (currentFirebaseUser) {
        loginForm.style.display = 'none';
        loggedInRow.style.display = 'flex';
        document.getElementById('authUserEmail').textContent = currentFirebaseUser.email;
      } else {
        loginForm.style.display = 'block';
        loggedInRow.style.display = 'none';
      }
    }

    async function cloudSaveTranslation(translatedText) {
      if (!currentFirebaseUser || !_fbDb) return;
      if (!translatedText) return;
      try {
        const uid = currentFirebaseUser.uid;
        const docRef = _fbDb.collection('users').doc(uid).collection('translations').doc();
        const id = docRef.id;

        // Split text into 600K-char chunks to stay under Firestore 1MB/doc limit
        const textChunks = [];
        for (let i = 0; i < translatedText.length; i += FIRESTORE_CHUNK_SIZE) {
          textChunks.push(translatedText.slice(i, i + FIRESTORE_CHUNK_SIZE));
        }

        // Write metadata doc first
        await docRef.set({
          fileName: originalFileName || 'unknown.txt',
          completedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          charCount: translatedText.length,
          model: getSelectedModel(),
          provider: getActiveProvider(),
          totalChunks: totalChunks,
          completedChunks: totalChunks,
          status: 'completed',
          textChunkCount: textChunks.length,
          promptTokens: usageStats.promptTokens,
          completionTokens: usageStats.completionTokens,
          cost: usageStats.totalCost,
        });

        // Write text chunks in parallel
        const chunksRef = docRef.collection('chunks');
        await Promise.all(textChunks.map(function(chunk, idx) {
          return chunksRef.doc(String(idx)).set({ text: chunk });
        }));

        showCloudToast('☁️ Đã lưu lên cloud!');
        loadCloudHistory();
      } catch (e) {
        console.error('Cloud save error:', e);
        showCloudToast('Lỗi lưu cloud: ' + e.message, true);
      }
    }

    function sanitizeDocId(value) {
      return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 180);
    }

    function buildProgressDocId(fileHash, provider, model, chunkSize, scopePercent) {
      return CLOUD_PROGRESS_PREFIX + sanitizeDocId([fileHash || 'nofile', provider || 'na', model || 'na', chunkSize || '0', scopePercent || '100'].join('_'));
    }

    async function writeLargeTextSubcollection(docRef, collectionName, text) {
      const value = String(text || '');
      const chunks = [];
      for (let i = 0; i < value.length; i += FIRESTORE_CHUNK_SIZE) {
        chunks.push(value.slice(i, i + FIRESTORE_CHUNK_SIZE));
      }
      if (chunks.length === 0) chunks.push('');
      await Promise.all(chunks.map(function(chunk, idx) {
        return docRef.collection(collectionName).doc(String(idx)).set({ text: chunk });
      }));
      return chunks.length;
    }

    async function readLargeTextSubcollection(docRef, collectionName, chunkCount) {
      const safeCount = Math.max(0, Number(chunkCount) || 0);
      if (safeCount === 0) return '';
      const snaps = await Promise.all(
        Array.from({ length: safeCount }, function(_, i) { return docRef.collection(collectionName).doc(String(i)).get(); })
      );
      return snaps.map(function(s) { return s.data() ? s.data().text : ''; }).join('');
    }

    async function cloudSaveTranslationProgress(options) {
      if (!currentFirebaseUser || !_fbDb) return;
      const now = Date.now();
      const force = Boolean(options?.force);
      if (!force && now - lastCloudProgressSavedAt < 6000) return;
      lastCloudProgressSavedAt = now;

      const provider = options?.provider || getActiveProvider();
      const model = options?.model || getSelectedModel();
      const chunkSize = options?.chunkSize || (Number.parseInt(document.getElementById('chunkSize')?.value, 10) || 6000);
      const scopePercent = options?.scopePercent || 100;
      const translated = Array.isArray(options?.translatedChunks) ? options.translatedChunks : [];
      const total = Number(options?.totalChunks) || translated.length;
      const done = translated.filter(Boolean).length;
      const status = options?.status || 'in_progress';
      const fileHash = options?.fileHash || currentFileHash || '';
      if (!fileHash || !total) return;

      const uid = currentFirebaseUser.uid;
      const docId = buildProgressDocId(fileHash, provider, model, chunkSize, scopePercent);
      const docRef = _fbDb.collection('users').doc(uid).collection('translations').doc(docId);

      const partialText = translated.filter(Boolean).join('\n\n');
      const checkpointPayload = JSON.stringify({
        translatedChunks: translated,
        totalChunks: total
      });

      const [textChunkCount, checkpointChunkCount] = await Promise.all([
        writeLargeTextSubcollection(docRef, 'chunks', partialText),
        writeLargeTextSubcollection(docRef, 'checkpoint_chunks', checkpointPayload)
      ]);

      await docRef.set({
        fileName: originalFileName || options?.fileName || 'unknown.txt',
        fileHash: fileHash,
        provider: provider,
        model: model,
        chunkSize: chunkSize,
        scopePercent: scopePercent,
        totalChunks: total,
        completedChunks: done,
        status: status,
        charCount: partialText.length,
        textChunkCount: textChunkCount,
        checkpointChunkCount: checkpointChunkCount,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        completedAt: status === 'completed' ? firebase.firestore.FieldValue.serverTimestamp() : null
      }, { merge: true });
    }

    async function cloudFindResumeCandidate(fileHash, provider, model, chunkSize, scopePercent) {
      if (!currentFirebaseUser || !_fbDb || !fileHash) return null;
      const uid = currentFirebaseUser.uid;
      const docId = buildProgressDocId(fileHash, provider, model, chunkSize, scopePercent);
      const docRef = _fbDb.collection('users').doc(uid).collection('translations').doc(docId);
      const snap = await docRef.get();
      if (!snap.exists) return null;
      const data = snap.data() || {};
      if (!Number(data.completedChunks) || Number(data.completedChunks) >= Number(data.totalChunks || 0)) return null;
      return Object.assign({ id: docId }, data);
    }

    async function cloudLoadResumeCheckpoint(docId) {
      if (!currentFirebaseUser || !_fbDb || !docId) return null;
      const uid = currentFirebaseUser.uid;
      const docRef = _fbDb.collection('users').doc(uid).collection('translations').doc(docId);
      const snap = await docRef.get();
      if (!snap.exists) return null;
      const data = snap.data() || {};
      const raw = await readLargeTextSubcollection(docRef, 'checkpoint_chunks', data.checkpointChunkCount);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.translatedChunks)) return null;
      return {
        translatedChunks: parsed.translatedChunks,
        totalChunks: Number(parsed.totalChunks) || parsed.translatedChunks.length
      };
    }

    async function loadCloudHistory() {
      if (!currentFirebaseUser || !_fbDb) return;
      try {
        const uid = currentFirebaseUser.uid;
        const snap = await _fbDb
          .collection('users').doc(uid).collection('translations')
          .orderBy('updatedAt', 'desc')
          .limit(50)
          .get();
        cloudHistory = snap.docs.map(function(doc) {
          return Object.assign({ id: doc.id }, doc.data());
        });
        renderTranslationHistory();
      } catch (e) {
        console.error('Load cloud history error:', e);
      }
    }

    async function downloadCloudFile(id, fileName) {
      if (!currentFirebaseUser || !_fbDb) return;
      const btn = document.getElementById('hist-dl-' + id);
      if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
      try {
        const uid = currentFirebaseUser.uid;
        const metaDoc = cloudHistory.find(function(h) { return h.id === id; });
        const chunkCount = (metaDoc && metaDoc.textChunkCount) || 1;

        // Fetch all text chunks in order
        const chunksRef = _fbDb.collection('users').doc(uid).collection('translations').doc(id).collection('chunks');
        const snaps = await Promise.all(
          Array.from({ length: chunkCount }, function(_, i) { return chunksRef.doc(String(i)).get(); })
        );
        const fullText = snaps.map(function(s) { return s.data() ? s.data().text : ''; }).join('');

        const blob = new Blob([fullText], { type: 'text/plain; charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = (fileName || 'translated').replace(/\.[^.]+$/, '') + '_dich.txt';
        link.click();
        URL.revokeObjectURL(link.href);
      } catch (e) {
        alert('Lỗi tải file: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '⬇️ Tải về'; }
      }
    }

    async function deleteCloudFile(id) {
      if (!confirm('Xóa bản dịch này khỏi cloud?')) return;
      if (!currentFirebaseUser || !_fbDb) return;
      try {
        const uid = currentFirebaseUser.uid;
        const docRef = _fbDb.collection('users').doc(uid).collection('translations').doc(id);

        // Delete all text chunks first
        const metaDoc = cloudHistory.find(function(h) { return h.id === id; });
        const chunkCount = (metaDoc && metaDoc.textChunkCount) || 0;
        const checkpointChunkCount = (metaDoc && metaDoc.checkpointChunkCount) || 0;
        if (chunkCount > 0) {
          await Promise.all(
            Array.from({ length: chunkCount }, function(_, i) {
              return docRef.collection('chunks').doc(String(i)).delete();
            })
          );
        }
        if (checkpointChunkCount > 0) {
          await Promise.all(
            Array.from({ length: checkpointChunkCount }, function(_, i) {
              return docRef.collection('checkpoint_chunks').doc(String(i)).delete();
            })
          );
        }
        await docRef.delete();
        cloudHistory = cloudHistory.filter(function(t) { return t.id !== id; });
        renderTranslationHistory();
      } catch (e) {
        alert('Lỗi xóa: ' + e.message);
      }
    }

    function hEsc(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function showCloudToast(message, isError) {
      const t = document.getElementById('cloudToast');
      if (!t) return;
      t.textContent = message;
      t.className = 'cloud-toast' + (isError ? ' error' : '');
      t.classList.add('visible');
      clearTimeout(t._hideTimer);
      t._hideTimer = setTimeout(function() { t.classList.remove('visible'); }, 3500);
    }
