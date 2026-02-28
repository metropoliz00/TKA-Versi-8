
import { User, Exam, QuestionWithOptions, QuestionRow, SchoolSchedule } from '../types';

// The Apps Script Web App URL provided via environment variable with a fallback
let savedUrl = localStorage.getItem('cbt_gas_url');
if (savedUrl === 'undefined' || savedUrl === 'null') savedUrl = null;

let GAS_EXEC_URL = savedUrl || import.meta.env.VITE_GAS_URL || "https://script.google.com/macros/s/AKfycbzBoEP0rpV5FlLcVRh8TVJk1gPmfu-qagsokpwiinf2r26Z5urhGg62RD23o1fY6pm2wQ/exec";

export const updateGasUrl = (newUrl: string) => {
    if (!newUrl || newUrl === 'undefined' || newUrl === 'null') return;
    GAS_EXEC_URL = newUrl;
    localStorage.setItem('cbt_gas_url', newUrl);
};

// Check if running inside GAS iframe
const isEmbedded = typeof window !== 'undefined' && window.google && window.google.script;

// Helper to format Google Drive URLs to direct image links
const formatGoogleDriveUrl = (url?: string): string | undefined => {
    if (!url) return undefined;
    if (typeof url !== 'string') return url;
    try {
        // Handle Google Drive / Docs links
        if (url.includes('drive.google.com') || url.includes('docs.google.com')) {
            // Regex to find ID (alphanumeric, -, _, length 25+)
            const match = url.match(/[-\w]{25,}/);
            if (match) {
                // Use thumbnail endpoint which is often more reliable for <img> tags
                // sz=w1000 sets width to 1000px to ensure good quality
                return `https://drive.google.com/thumbnail?id=${match[0]}&sz=w1000`;
            }
        }
    } catch (e) { 
        return url; 
    }
    return url;
};

// Helper to call backend functions with RETRY Logic
const callBackend = async (fnName: string, ...args: any[]) => {
  // 1. Embedded Mode (GoogleScript Run)
  if (isEmbedded) {
    return new Promise((resolve, reject) => {
      window.google!.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(reject)
        [fnName](...args);
    });
  }

  // 2. Remote Mode (Fetch to Exec URL) with Retry
  if (GAS_EXEC_URL) {
      let attempt = 0;
      const maxAttempts = 5;
      
      const readOnlyActions = [
          'checkUserStatus', 'getSubjectList', 'getTokenFromConfig', 
          'getQuestionsFromSheet', 'getRawQuestions', 'getDashboardData', 
          'getUsers', 'getSchoolSchedules', 'adminGetSurveyRecap', 
          'getRecapData', 'getAnalysisData', 'getAllConfig',
          'getStudentExamProgress', 'saveStudentExamProgress'
      ];
      
      const isReadOnly = readOnlyActions.includes(fnName);
      
      while (attempt < maxAttempts) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
          
          try {
              let url = GAS_EXEC_URL.includes('?') 
                  ? `${GAS_EXEC_URL}&t=${new Date().getTime()}`
                  : `${GAS_EXEC_URL}?t=${new Date().getTime()}`;
                  
              let fetchOptions: RequestInit = {
                  mode: 'cors',
                  credentials: 'omit',
                  redirect: "follow", 
                  signal: controller.signal
              };
              
              if (isReadOnly) {
                  fetchOptions.method = 'GET';
                  url += `&action=${encodeURIComponent(fnName)}&args=${encodeURIComponent(JSON.stringify(args))}`;
              } else {
                  fetchOptions.method = 'POST';
                  fetchOptions.headers = { 'Content-Type': 'text/plain' };
                  fetchOptions.body = JSON.stringify({ action: fnName, args: args });
              }
              
              const response = await fetch(url, fetchOptions);
              
              clearTimeout(timeoutId);
              
              if (!response.ok) {
                  throw new Error(`Server Error (${response.status})`);
              }
              
              const text = await response.text();
              let json;
              try {
                  json = JSON.parse(text);
              } catch (e) {
                  if (text.includes("<!DOCTYPE html>")) {
                      throw new Error("Script Error: Check Apps Script Executions.");
                  }
                  throw new Error("Invalid JSON response");
              }
              
              if (json && json.error) {
                  if (json.error.includes("Action not found")) return json;
                  throw new Error(json.error);
              }
              return json;

          } catch (error: any) {
              clearTimeout(timeoutId);
              attempt++;
              
              if (error.name === 'AbortError') {
                  console.warn(`API Call '${fnName}' timed out (Attempt ${attempt})`);
              } else {
                  console.warn(`API Call '${fnName}' failed (Attempt ${attempt}):`, error);
              }
              
              if (attempt === maxAttempts) throw error;
              await new Promise(r => setTimeout(r, 1000 * attempt));
          }
      }
  }

  throw new Error("No backend connection available");
};

export const api = {
  // Unified Login Function
  login: async (username: string, password?: string): Promise<User> => {
    const result: any = await callBackend('login', username, password);
    
    if (result && result.success && result.user) {
        return {
            id: result.user.username || result.user.id || '',
            username: result.user.username || '',
            role: result.user.role || 'siswa',
            nama_lengkap: result.user.fullname || result.user.nama_lengkap || '',
            jenis_kelamin: result.user.gender || result.user.jenis_kelamin || 'L', 
            kelas_id: result.user.school || result.user.kelas_id || '',
            kecamatan: result.user.kecamatan || '', 
            active_exam: result.user.active_exam || '', 
            session: result.user.session || '',
            photo_url: formatGoogleDriveUrl(result.user.photo_url),
            id_sekolah: result.user.id_sekolah || '',
            id_gugus: result.user.id_gugus || '',
            id_kecamatan: result.user.id_kecamatan || ''
        };
    }
    
    throw new Error(result?.message || 'Username tidak ditemukan atau password salah.');
  },

  // Start Exam
  startExam: async (username: string, fullname: string, subject: string): Promise<any> => {
      return await callBackend('startExam', username, fullname, subject);
  },

  // Check Status (For Polling Reset)
  checkStatus: async (username: string): Promise<{ status: string, message?: string }> => {
      const res: any = await callBackend('checkUserStatus', username);
      return res;
  },

  // Get Exams / Subject List
  getExams: async (): Promise<Exam[]> => {
    const response: any = await callBackend('getSubjectList');
    let subjects: string[] = [];
    let duration = 60;
    let maxQuestions = 0;
    let surveyDuration = 30; 
    let showSurvey = true;

    if (Array.isArray(response)) {
        subjects = response;
    } else if (response && response.subjects) {
        subjects = response.subjects;
        duration = response.duration || 60;
        maxQuestions = response.maxQuestions || 0;
        surveyDuration = response.surveyDuration || 30;
        if (response.showSurvey !== undefined) showSurvey = response.showSurvey;
    }

    if (subjects.length > 0) {
        const exams: Exam[] = subjects.map((s) => ({
            id: s,
            nama_ujian: s,
            waktu_mulai: new Date().toISOString(),
            durasi: Number(duration),
            token_akses: 'TOKEN', 
            is_active: true,
            max_questions: Number(maxQuestions),
            id_sekolah: undefined, 
            id_kecamatan: undefined,
            id_gelombang: undefined 
        }));

        if (showSurvey) {
            exams.push(
                {
                    id: 'Survey_Karakter',
                    nama_ujian: 'Survey Karakter',
                    waktu_mulai: new Date().toISOString(),
                    durasi: Number(surveyDuration),
                    token_akses: '',
                    is_active: true,
                    max_questions: 0,
                    id_sekolah: undefined,
                    id_kecamatan: undefined,
                    id_gelombang: undefined
                },
                {
                    id: 'Survey_Lingkungan',
                    nama_ujian: 'Survey Lingkungan Belajar',
                    waktu_mulai: new Date().toISOString(),
                    durasi: Number(surveyDuration),
                    token_akses: '',
                    is_active: true,
                    max_questions: 0,
                    id_sekolah: undefined,
                    id_kecamatan: undefined,
                    id_gelombang: undefined
                }
            );
        }
        return exams;
    }
    return [];
  },

  // Get Server Token
  getServerToken: async (): Promise<string> => {
      return await callBackend('getTokenFromConfig') as string;
  },

  // Save Token
  saveToken: async (newToken: string): Promise<{success: boolean}> => {
      return await callBackend('saveConfig', 'TOKEN', newToken);
  },
  
  // Save Duration
  saveDuration: async (minutes: number): Promise<{success: boolean}> => {
      return await callBackend('saveConfig', 'DURATION', minutes);
  },

  // Save Survey Duration
  saveSurveyDuration: async (minutes: number): Promise<{success: boolean}> => {
      return await callBackend('saveConfig', 'SURVEY_DURATION', minutes);
  },

  // Save Max Questions
  saveMaxQuestions: async (amount: number): Promise<{success: boolean}> => {
      return await callBackend('saveConfig', 'MAX_QUESTIONS', amount);
  },

  // Generic Save Config
  saveConfig: async (key: string, value: any): Promise<{success: boolean}> => {
      return await callBackend('saveConfig', key, value);
  },

  // Get All Config
  getAllConfig: async (): Promise<Record<string, string>> => {
      try {
          const result: any = await callBackend('getAllConfig');
          if (result && result.error && result.error.includes("Action not found")) {
              console.warn("getAllConfig action not found in backend. Please re-deploy Apps Script.");
              return {};
          }
          return result || {};
      } catch (e) {
          // Downgrade to warn to avoid cluttering console if backend is temporarily unavailable
          console.warn("Unable to fetch remote config (using defaults):", e); 
          return {};
      }
  },

  // Get Questions from Sheet (Formatted for Exam)
  getQuestions: async (subject: string): Promise<QuestionWithOptions[]> => {
    const data: any = await callBackend('getQuestionsFromSheet', subject);
    if (!Array.isArray(data)) return [];

    return data.map((q: any, i: number) => ({
        id: q.id || `Q${i+1}`,
        exam_id: subject,
        text_soal: q.text || q.text_soal || "Pertanyaan tanpa teks",
        tipe_soal: q.type || q.tipe_soal || 'PG',
        bobot_nilai: q.bobot || q.bobot_nilai || 10,
        gambar: q.image || q.gambar || undefined,
        keterangan_gambar: q.keterangan_gambar || undefined, // Map caption
        options: Array.isArray(q.options) ? q.options.map((o: any, idx: number) => ({
            id: o.id || `opt-${i}-${idx}`,
            question_id: q.id || `Q${i+1}`,
            text_jawaban: o.text_jawaban || o.text || "", 
            is_correct: false 
        })) : []
    }));
  },

  // --- SURVEY SPECIFIC ---
  getSurveyQuestions: async (surveyType: 'Survey_Karakter' | 'Survey_Lingkungan'): Promise<QuestionWithOptions[]> => {
      const data: any = await callBackend('getQuestionsFromSheet', surveyType);
      if (!Array.isArray(data)) return [];

      return data.map((q: any, i: number) => ({
          id: q.id || `S${i+1}`,
          exam_id: surveyType,
          text_soal: q.text || q.text_soal || "Pertanyaan tanpa teks",
          tipe_soal: 'LIKERT',
          bobot_nilai: 0,
          options: Array.isArray(q.options) ? q.options.map((o: any, idx: number) => ({
              id: o.id,
              question_id: q.id,
              text_jawaban: o.text_jawaban || o.text || "",
              is_correct: false
          })) : []
      }));
  },

  submitSurvey: async (payload: { user: User, surveyType: string, answers: any, startTime: number }) => {
      return await callBackend('submitSurvey', payload.user.username, payload.user.nama_lengkap, payload.user.kelas_id, payload.user.kecamatan || '-', payload.surveyType, payload.answers, payload.startTime);
  },

  getSurveyRecap: async (surveyType: string): Promise<any[]> => {
      const res = await callBackend('adminGetSurveyRecap', surveyType);
      if (!Array.isArray(res)) return [];
      return res.map((r: any) => ({
          ...r,
          nama: r.fullname || r.nama || '',
          sekolah: r.school || r.sekolah || '',
          kecamatan: r.kecamatan || '',
          id_sekolah: r.id_sekolah || '',
          id_gugus: r.id_gugus || '',
          id_kecamatan: r.id_kecamatan || ''
      }));
  },

  // --- ADMIN CRUD ---
  getRawQuestions: async (subject: string): Promise<QuestionRow[]> => {
      const result = await callBackend('getRawQuestions', subject);
      if (Array.isArray(result)) {
          return result.map((q: any) => ({
              ...q,
              id: q.id || '',
              text_soal: q.text || q.text_soal || '',
              tipe_soal: q.type || q.tipe_soal || 'PG',
              gambar: q.image || q.gambar || '',
              keterangan_gambar: q.keterangan_gambar || '',
              opsi_a: q.opsi_a || '',
              opsi_b: q.opsi_b || '',
              opsi_c: q.opsi_c || '',
              opsi_d: q.opsi_d || '',
              kunci_jawaban: q.kunci_jawaban || '',
              bobot: q.bobot || 10
          }));
      }
      return [];
  },
  
  // Save Question
  saveQuestion: async (subject: string, data: QuestionRow): Promise<{success: boolean, message: string}> => {
      return await callBackend('saveQuestion', subject, data);
  },

  // Import Questions
  importQuestions: async (subject: string, data: QuestionRow[]): Promise<{success: boolean, message: string}> => {
      return await callBackend('importQuestions', subject, data);
  },

  // Delete Question
  deleteQuestion: async (subject: string, id: string): Promise<{success: boolean, message: string}> => {
      return await callBackend('deleteQuestion', subject, id);
  },

  // Get All Users
  getUsers: async (): Promise<any[]> => {
      const users: any = await callBackend('getUsers');
      if (Array.isArray(users)) {
          return users.map((u: any) => ({
              ...u,
              id: u.username || u.id || '',
              username: u.username || '',
              password: u.password || '',
              role: u.role || 'siswa',
              nama_lengkap: u.fullname || u.nama_lengkap || '',
              jenis_kelamin: u.gender || u.jenis_kelamin || 'L',
              kelas_id: u.school || u.kelas_id || '',
              kecamatan: u.kecamatan || '',
              active_exam: u.active_exam || '',
              session: u.session || '',
              id_sekolah: u.id_sekolah || '',
              id_gugus: u.id_gugus || '',
              id_kecamatan: u.id_kecamatan || '',
              photo_url: formatGoogleDriveUrl(u.photo_url)
          }));
      }
      return [];
  },

  // Save User
  saveUser: async (userData: any): Promise<{success: boolean, message: string}> => {
      return await callBackend('saveUser', userData);
  },

  // Delete User
  deleteUser: async (userId: string): Promise<{success: boolean, message: string}> => {
      return await callBackend('deleteUser', userId);
  },

  // Import Users
  importUsers: async (users: any[]): Promise<{success: boolean, message: string}> => {
      return await callBackend('importUsers', users);
  },

  // Assign Test Group
  assignTestGroup: async (usernames: string[], examId: string, session: string): Promise<{success: boolean}> => {
      return await callBackend('assignTestGroup', usernames, examId, session);
  },

  // Update User Sessions
  updateUserSessions: async (updates: {username: string, session: string}[]): Promise<{success: boolean}> => {
      return await callBackend('updateUserSessions', updates);
  },

  // Reset Login
  resetLogin: async (username: string): Promise<{success: boolean}> => {
      return await callBackend('resetLogin', username);
  },
  
  // Check Session Time
  checkSession: async (username: string): Promise<{success: boolean, message: string}> => {
      return await callBackend('checkSession', username);
  },

  // Initialize System Headers
  initSystem: async (): Promise<{success: boolean, message: string}> => {
      return await callBackend('initSystem');
  },
  
  // Get School Schedules
  getSchoolSchedules: async (): Promise<SchoolSchedule[]> => {
      return await callBackend('getSchoolSchedules');
  },

  // Save School Schedules
  saveSchoolSchedules: async (schedules: SchoolSchedule[]): Promise<{success: boolean}> => {
      return await callBackend('saveSchoolSchedules', schedules);
  },

  // Corrected function names to match Code.gs
  getRecap: async (): Promise<any[]> => {
      const res = await callBackend('getRecapData');
      if (!Array.isArray(res)) return [];
      // Map backend keys (fullname, school, subject, score, duration) to frontend keys (nama, sekolah, mapel, nilai, durasi)
      return res.map((r: any) => ({
          ...r,
          nama: r.fullname || r.nama || '',
          sekolah: r.school || r.sekolah || '',
          mapel: r.subject || r.mapel || '',
          durasi: r.duration || r.durasi || '',
          nilai: r.score !== undefined ? r.score : (r.nilai !== undefined ? r.nilai : 0),
          kecamatan: r.kecamatan || '',
          id_sekolah: r.id_sekolah || '',
          id_gugus: r.id_gugus || '',
          id_kecamatan: r.id_kecamatan || ''
      }));
  },

  getAnalysis: async (subject: string): Promise<any> => {
      return await callBackend('getAnalysisData', subject);
  },

  // Submit Exam
  submitExam: async (payload: { user: User, subject: string, answers: any, startTime: number, displayedQuestionCount?: number, questionIds?: string[] }) => {
      const scoreInfo = { total: 0, answered: Object.keys(payload.answers).length };
      return await callBackend(
          'submitAnswers', 
          payload.user.username, 
          payload.user.nama_lengkap, 
          payload.user.kelas_id, 
          payload.subject, 
          payload.answers, 
          scoreInfo, 
          payload.startTime, 
          payload.displayedQuestionCount || 0, 
          payload.questionIds || [] 
      );
  },
  
  // Clear Cache
  clearAllCache: async (): Promise<{success: boolean, message: string}> => {
      return await callBackend('clearAllCache') as any;
  },

  // Dashboard Data
  getDashboardData: async () => {
      const data: any = await callBackend('getDashboardData');
      if (data && Array.isArray(data.allUsers)) {
          data.allUsers = data.allUsers.map((u: any) => ({
              ...u,
              id: u.username || u.id || '',
              username: u.username || '',
              password: u.password || '',
              role: u.role || 'siswa',
              nama_lengkap: u.fullname || u.nama_lengkap || '',
              jenis_kelamin: u.gender || u.jenis_kelamin || 'L',
              kelas_id: u.school || u.kelas_id || '',
              kecamatan: u.kecamatan || '',
              active_exam: u.active_exam || '',
              session: u.session || '',
              id_sekolah: u.id_sekolah || '',
              id_gugus: u.id_gugus || '',
              id_kecamatan: u.id_kecamatan || '',
              photo_url: formatGoogleDriveUrl(u.photo_url)
          }));
      }
      return data;
  },

  // Save Exam Progress
  saveExamProgress: async (userId: string, examId: string, progress: { answers: Record<string, any>, currentQuestionIndex: number }): Promise<{success: boolean}> => {
      return await callBackend('saveStudentExamProgress', userId, examId, progress);
  },

  // Get Exam Progress
  getExamProgress: async (userId: string, examId: string): Promise<{ answers: Record<string, any>, currentQuestionIndex: number } | null> => {
      const result: any = await callBackend('getStudentExamProgress', userId, examId);
      if (result && result.answers && typeof result.currentQuestionIndex === 'number') {
          return result;
      }
      return null;
  }
};
