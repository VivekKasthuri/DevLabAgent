#!/usr/bin/env node
// export-training-data.mjs — harvest DevLab knowledge into fine-tuning data.
//
// Sources:
//   1. DevLab chat history (session_turns from ~/.devlab/memory.db)
//   2. .devlab/kb/KNOWLEDGE.md entries (patterns, gotchas, decisions)
//   3. rubric.json / review artifacts if present
//   4. Built-in seed set: security + Swift/Kotlin/Flutter/RN/JS/Python/Go/Rust
//
// Output: train.jsonl — chat-format instruction pairs compatible with
// Unsloth / axolotl / HF TRL for QLoRA fine-tuning of CodeLlama 34B.
//
// Usage:
//   node scripts/export-training-data.mjs [repoDir ...] [--out train.jsonl] [--with-history]
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args.splice(outIdx, 2)[1] : 'train.jsonl';
const withHistory = args.includes('--with-history');
const dirs = args.filter(a => !a.startsWith('--')).length
  ? args.filter(a => !a.startsWith('--'))
  : ['.'];

const SYSTEM = `You are DevLab Coder, an expert autonomous coding agent.
You specialize in: Swift, Kotlin, Flutter/Dart, React Native, JavaScript/TypeScript, Python, Go, Rust, Java.
You fix bugs, write tests, review PRs, scaffold projects, and apply security best practices.`;

const rows = [];
const add = (user, assistant) =>
  rows.push({ messages: [
    { role: 'system',    content: SYSTEM },
    { role: 'user',      content: user },
    { role: 'assistant', content: assistant }
  ]});

// ── 1. DevLab chat history from memory.db ────────────────────────────────────
if (withHistory) {
  const dbPath = process.env.MEMORY_DB_PATH
    || path.join(homedir(), '.devlab', 'memory.db');
  if (fs.existsSync(dbPath)) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readonly: true });
      // Get all sessions with their turns as user→assistant pairs
      const sessions = db.prepare(
        `SELECT s.id, s.project FROM sessions s ORDER BY s.started_at DESC`
      ).all();
      let historyCount = 0;
      for (const session of sessions) {
        const turns = db.prepare(
          `SELECT role, content FROM session_turns
           WHERE session_id=? AND length(content) > 50
           ORDER BY id`
        ).all(session.id);
        // Pair user + assistant turns
        for (let i = 0; i < turns.length - 1; i++) {
          if (turns[i].role === 'user' && turns[i+1].role === 'assistant') {
            const user = turns[i].content.trim();
            const asst = turns[i+1].content.trim();
            // Filter: skip very short or tool-only responses
            if (user.length > 30 && asst.length > 50) {
              add(user, asst);
              historyCount++;
              i++; // skip the assistant turn we just used
            }
          }
        }
      }
      db.close();
      console.log(`Chat history: ${historyCount} examples from memory.db`);
    } catch (e) {
      console.warn(`Could not read memory.db: ${e.message}`);
    }
  } else {
    console.warn(`memory.db not found at ${dbPath} — skipping history`);
  }
}

// ── 2. Knowledge base entries ─────────────────────────────────────────────────
for (const dir of dirs) {
  const kbFile = path.join(path.resolve(dir), '.devlab/kb/KNOWLEDGE.md');
  if (!fs.existsSync(kbFile)) continue;
  const md = fs.readFileSync(kbFile, 'utf8');
  let category = 'pattern';
  for (const line of md.split('\n')) {
    const h = line.match(/^##\s+(\w+)/);
    if (h) { category = h[1].toLowerCase(); continue; }
    const m = line.match(/^-\s+(.+?)(?:\s+_\(.*\)_)?\s*$/);
    if (!m || m[1].startsWith('<!--')) continue;
    const text = m[1].trim();
    if (text.length < 20) continue;
    add(
      `What is an important ${category} to follow in this codebase?`,
      `${text}\n\nApply this consistently in all related changes.`
    );
  }
  console.log(`KB ${kbFile}: harvested ${rows.length} entries so far`);
}

// ── 3. Rubric criteria ────────────────────────────────────────────────────────
for (const dir of dirs) {
  const rubricFile = path.join(path.resolve(dir), 'rubric.json');
  if (!fs.existsSync(rubricFile)) continue;
  try {
    const rubric = JSON.parse(fs.readFileSync(rubricFile, 'utf8'));
    for (const c of rubric.criteria || []) {
      const checks = (c.checks || []).map((x) => `- ${x}`).join('\n');
      add(
        `When reviewing code for "${c.title || c.id}", what should you check?`,
        `Key checks for ${c.title || c.id} (weight ${c.weight ?? 'n/a'}):\n${checks || c.description || 'Follow project standards.'}`
      );
    }
    console.log(`Rubric ${rubricFile}: ${rubric.criteria?.length ?? 0} criteria`);
  } catch { /* skip malformed */ }
}

// ── 4. Built-in seed set ──────────────────────────────────────────────────────
// Security seeds
const SECURITY_SEEDS = [
  ['Review: db.query("SELECT * FROM users WHERE id=" + req.params.id)',
   'SECURITY: HIGH — SQL injection (CWE-89). User input is concatenated into the query.\n\nFix:\n```js\ndb.query("SELECT * FROM users WHERE id = ?", [req.params.id]);\n```\nAlways use parameterized queries; never concatenate untrusted input into SQL.'],
  ['Review: element.innerHTML = userComment;',
   'SECURITY: HIGH — Cross-site scripting (CWE-79). Untrusted content assigned to innerHTML executes scripts.\n\nFix:\n```js\nelement.textContent = userComment;\n```\nUse textContent, or sanitize with DOMPurify if HTML rendering is required.'],
  ['Review: const apiKey = "sk-live-abc123"; fetch(url, {headers:{Authorization: apiKey}})',
   'SECURITY: HIGH — Hardcoded secret (CWE-798). Credentials in source leak via VCS.\n\nFix:\n```js\nconst apiKey = process.env.API_KEY;\nif (!apiKey) throw new Error("API_KEY not set");\n```\nLoad secrets from environment variables or a secrets manager.'],
  ['Review: exec("convert " + filename + " out.png")',
   'SECURITY: CRITICAL — Command injection (CWE-78). Shell metacharacters in filename execute arbitrary commands.\n\nFix:\n```js\nexecFile("convert", [filename, "out.png"]);\n```\nUse execFile/spawn with an argument array.'],
  ['Review: jwt.verify(token, secret, { algorithms: ["none", "HS256"] })',
   'SECURITY: CRITICAL — JWT "none" algorithm accepted (CWE-347). Attackers can forge unsigned tokens.\n\nFix:\n```js\njwt.verify(token, secret, { algorithms: ["HS256"] });\n```\nNever include "none".'],
];

// Swift seeds
const SWIFT_SEEDS = [
  ['Write a Swift function to safely unwrap an optional and handle nil',
   '```swift\nfunc processUser(_ user: User?) {\n    guard let user = user else {\n        print("No user provided")\n        return\n    }\n    // Safe to use user here\n    print(user.name)\n}\n```\nAlways use `guard let` or `if let` to safely unwrap optionals. Never force-unwrap with `!` unless you are 100% certain the value exists.'],
  ['Write a Swift async function to fetch JSON from an API',
   '```swift\nstruct User: Codable {\n    let id: Int\n    let name: String\n}\n\nfunc fetchUser(id: Int) async throws -> User {\n    let url = URL(string: "https://api.example.com/users/\\(id)")!\n    let (data, response) = try await URLSession.shared.data(from: url)\n    \n    guard let httpResponse = response as? HTTPURLResponse,\n          httpResponse.statusCode == 200 else {\n        throw URLError(.badServerResponse)\n    }\n    \n    return try JSONDecoder().decode(User.self, from: data)\n}\n```\nAlways check the HTTP status code. Use `async throws` for network calls.'],
  ['Fix this Swift memory leak: class ViewController { var timer: Timer? func start() { timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in self.update() } } }',
   '```swift\nclass ViewController: UIViewController {\n    var timer: Timer?\n    \n    func start() {\n        // Use [weak self] to break the retain cycle\n        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in\n            self?.update()\n        }\n    }\n    \n    override func viewDidDisappear(_ animated: Bool) {\n        super.viewDidDisappear(animated)\n        timer?.invalidate()\n        timer = nil\n    }\n}\n```\nCapture lists `[weak self]` prevent retain cycles in closures. Always invalidate timers when the view disappears.'],
  ['Write a Swift ObservableObject ViewModel for a login screen',
   '```swift\nimport SwiftUI\nimport Combine\n\nclass LoginViewModel: ObservableObject {\n    @Published var email = ""\n    @Published var password = ""\n    @Published var isLoading = false\n    @Published var errorMessage: String?\n    \n    func login() async {\n        guard !email.isEmpty, !password.isEmpty else {\n            errorMessage = "Email and password required"\n            return\n        }\n        \n        await MainActor.run { isLoading = true }\n        \n        do {\n            try await AuthService.shared.login(email: email, password: password)\n            await MainActor.run { isLoading = false }\n        } catch {\n            await MainActor.run {\n                isLoading = false\n                errorMessage = error.localizedDescription\n            }\n        }\n    }\n}\n```\nAlways update `@Published` properties on `MainActor`. Use `async/await` for auth calls.'],
];

// Kotlin seeds
const KOTLIN_SEEDS = [
  ['Write a Kotlin coroutine to fetch data from an API in Android',
   '```kotlin\nclass UserRepository(private val api: ApiService) {\n    \n    suspend fun getUser(id: Int): Result<User> {\n        return try {\n            val user = api.fetchUser(id)  // suspend function\n            Result.success(user)\n        } catch (e: HttpException) {\n            Result.failure(e)\n        } catch (e: IOException) {\n            Result.failure(e)\n        }\n    }\n}\n\n// In ViewModel:\nclass UserViewModel(private val repo: UserRepository) : ViewModel() {\n    \n    private val _user = MutableStateFlow<User?>(null)\n    val user = _user.asStateFlow()\n    \n    fun loadUser(id: Int) {\n        viewModelScope.launch {\n            repo.getUser(id).onSuccess { _user.value = it }\n        }\n    }\n}\n```\nAlways use `viewModelScope` for coroutines in ViewModels — cancels automatically when ViewModel is cleared.'],
  ['Fix this Kotlin null pointer: val name = user.profile.name.toUpperCase()',
   '```kotlin\n// Safe version using safe-call operator and Elvis operator:\nval name = user?.profile?.name?.uppercase() ?: "Unknown"\n\n// Or with explicit null check:\nval name = if (user?.profile?.name != null) {\n    user.profile.name.uppercase()\n} else {\n    "Unknown"\n}\n```\nUse `?.` safe-call operator to chain nullable accesses. Use `?:` Elvis operator for defaults. Prefer `uppercase()` over deprecated `toUpperCase()`.'],
  ['Write a Kotlin Room database DAO for a User entity',
   '```kotlin\n@Entity(tableName = "users")\ndata class User(\n    @PrimaryKey val id: Int,\n    val name: String,\n    val email: String\n)\n\n@Dao\ninterface UserDao {\n    @Query("SELECT * FROM users WHERE id = :userId")\n    suspend fun getById(userId: Int): User?\n    \n    @Query("SELECT * FROM users")\n    fun getAllAsFlow(): Flow<List<User>>  // Flow for reactive updates\n    \n    @Insert(onConflict = OnConflictStrategy.REPLACE)\n    suspend fun upsert(user: User)\n    \n    @Delete\n    suspend fun delete(user: User)\n}\n```\nUse `Flow<>` return types for queries that should react to database changes. All write operations should be `suspend` functions.'],
];

// Flutter/Dart seeds
const FLUTTER_SEEDS = [
  ['Write a Flutter widget to fetch and display a list of users from an API',
   '```dart\nclass UserListScreen extends StatelessWidget {\n  const UserListScreen({super.key});\n  \n  @override\n  Widget build(BuildContext context) {\n    return Scaffold(\n      appBar: AppBar(title: const Text("Users")),\n      body: FutureBuilder<List<User>>(\n        future: ApiService.instance.fetchUsers(),\n        builder: (context, snapshot) {\n          if (snapshot.connectionState == ConnectionState.waiting) {\n            return const Center(child: CircularProgressIndicator());\n          }\n          if (snapshot.hasError) {\n            return Center(child: Text("Error: ${snapshot.error}"));\n          }\n          final users = snapshot.data ?? [];\n          return ListView.builder(\n            itemCount: users.length,\n            itemBuilder: (context, i) => ListTile(\n              title: Text(users[i].name),\n              subtitle: Text(users[i].email),\n            ),\n          );\n        },\n      ),\n    );\n  }\n}\n```\nAlways handle loading, error, and empty states in `FutureBuilder`. Use `const` constructors where possible for performance.'],
  ['Write a Flutter Riverpod provider to manage auth state',
   '```dart\nimport "package:riverpod_annotation/riverpod_annotation.dart";\n\npart "auth_provider.g.dart";\n\n@riverpod\nclass AuthNotifier extends _$AuthNotifier {\n  @override\n  AsyncValue<User?> build() {\n    return const AsyncValue.data(null);\n  }\n  \n  Future<void> login(String email, String password) async {\n    state = const AsyncValue.loading();\n    state = await AsyncValue.guard(() =>\n      ref.read(authServiceProvider).login(email, password)\n    );\n  }\n  \n  void logout() {\n    state = const AsyncValue.data(null);\n  }\n}\n```\nUse `AsyncValue.guard()` to automatically handle errors. Riverpod is preferred over Provider for new Flutter projects.'],
  ['Fix this Flutter setState called after widget disposed error',
   '```dart\nclass _MyWidgetState extends State<MyWidget> {\n  @override\n  void initState() {\n    super.initState();\n    // Check mounted before setState\n    fetchData().then((data) {\n      if (mounted) {  // ← Add this check\n        setState(() { _data = data; });\n      }\n    });\n  }\n  \n  // Better: use async/await pattern\n  @override\n  void initState() {\n    super.initState();\n    _loadData();\n  }\n  \n  Future<void> _loadData() async {\n    final data = await fetchData();\n    if (!mounted) return;  // ← Check before setState\n    setState(() { _data = data; });\n  }\n}\n```\nAlways check `mounted` before calling `setState` after an async gap. This prevents the "setState after dispose" error.'],
];

// React Native seeds
const RN_SEEDS = [
  ['Write a React Native component with TypeScript to display a user profile',
   '```tsx\nimport React from "react";\nimport { View, Text, Image, StyleSheet } from "react-native";\n\ninterface User {\n  name: string;\n  email: string;\n  avatar?: string;\n}\n\ninterface Props {\n  user: User;\n}\n\nexport const UserProfile: React.FC<Props> = ({ user }) => {\n  return (\n    <View style={styles.container}>\n      {user.avatar && (\n        <Image source={{ uri: user.avatar }} style={styles.avatar} />\n      )}\n      <Text style={styles.name}>{user.name}</Text>\n      <Text style={styles.email}>{user.email}</Text>\n    </View>\n  );\n};\n\nconst styles = StyleSheet.create({\n  container: { alignItems: "center", padding: 16 },\n  avatar: { width: 80, height: 80, borderRadius: 40 },\n  name: { fontSize: 18, fontWeight: "bold", marginTop: 8 },\n  email: { color: "#666" },\n});\n```\nAlways use `StyleSheet.create()` for styles — it improves performance by caching style objects.'],
  ['Write a React Native custom hook to fetch data with loading and error states',
   '```tsx\nimport { useState, useEffect } from "react";\n\ninterface FetchState<T> {\n  data: T | null;\n  loading: boolean;\n  error: string | null;\n  refetch: () => void;\n}\n\nexport function useFetch<T>(url: string): FetchState<T> {\n  const [data, setData] = useState<T | null>(null);\n  const [loading, setLoading] = useState(true);\n  const [error, setError] = useState<string | null>(null);\n  const [trigger, setTrigger] = useState(0);\n  \n  useEffect(() => {\n    let cancelled = false;\n    setLoading(true);\n    \n    fetch(url)\n      .then(res => {\n        if (!res.ok) throw new Error(`HTTP ${res.status}`);\n        return res.json();\n      })\n      .then(json => { if (!cancelled) setData(json); })\n      .catch(e => { if (!cancelled) setError(e.message); })\n      .finally(() => { if (!cancelled) setLoading(false); });\n    \n    return () => { cancelled = true; };  // Cleanup prevents state updates after unmount\n  }, [url, trigger]);\n  \n  return { data, loading, error, refetch: () => setTrigger(t => t + 1) };\n}\n```\nAlways cancel async operations in useEffect cleanup. This prevents memory leaks and stale state updates.'],
];

// Add all seeds
for (const [u, a] of [...SECURITY_SEEDS, ...SWIFT_SEEDS, ...KOTLIN_SEEDS, ...FLUTTER_SEEDS, ...RN_SEEDS]) {
  add(u, a);
}

// ── Write output ──────────────────────────────────────────────────────────────
fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`\n  ✅ Wrote ${rows.length} training examples to ${OUT}`);
console.log(`\n  Breakdown:`);
console.log(`    Security patterns : ${SECURITY_SEEDS.length}`);
console.log(`    Swift             : ${SWIFT_SEEDS.length}`);
console.log(`    Kotlin            : ${KOTLIN_SEEDS.length}`);
console.log(`    Flutter/Dart      : ${FLUTTER_SEEDS.length}`);
console.log(`    React Native      : ${RN_SEEDS.length}`);
console.log(`    KB/rubric/history : rest`);
console.log(`\n  Next step:`);
console.log(`    python scripts/finetune-qlora.py --data ${OUT}`);
