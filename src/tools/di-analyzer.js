// src/tools/di-analyzer.js
// Dependency Injection correctness & architecture conformance analyzer
// Supports: Swift/iOS, Kotlin/Android, Flutter/Dart, React Native, JS/TS, Python
import { readFileSync, existsSync } from 'fs';
import { resolve, join, extname, basename, relative } from 'path';
import { listFiles, readFile, searchFiles } from './files.js';
import { printTool, printWarn } from '../ui.js';

// Lazy-load routeChat so DI analysis always benefits from smart model routing.
// DI analysis is a complex review task → routed to REVIEW_MODEL (mistral:7b)
async function getChat() {
  const { routeChat } = await import('../router.js');
  // Wrap routeChat to match the chat() call signature used below
  return (opts) => routeChat({ ...opts, taskText: 'analyze dependency injection architecture review audit' });
}
import chalk from 'chalk';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Architecture & DI framework detection
// ─────────────────────────────────────────────────────────────────────────────

export async function detectArchitecture(projectPath = '.') {
  const abs = resolve(projectPath);
  const info = { projectPath: abs, architecture: 'unknown', diFramework: 'none', platform: 'unknown', layers: [], confidence: 'low' };

  // ── Platform ──
  const hasPubspec  = existsSync(join(abs, 'pubspec.yaml'));
  const hasPkg      = existsSync(join(abs, 'package.json'));
  const hasGradle   = existsSync(join(abs, 'build.gradle')) || existsSync(join(abs, 'build.gradle.kts'));
  const hasPkgSwift = existsSync(join(abs, 'Package.swift'));
  const hasXcodeProj = (await listFiles(abs, '*.xcodeproj', { maxResults: 3 })).count > 0;
  const hasGoMod    = existsSync(join(abs, 'go.mod'));
  const hasCargoToml = existsSync(join(abs, 'Cargo.toml'));
  const hasMavenPom = existsSync(join(abs, 'pom.xml'));

  if (hasPubspec) {
    const pub = readFileSync(join(abs, 'pubspec.yaml'), 'utf8');
    info.platform = 'flutter';
    if (/get_it|injectable/i.test(pub))          info.diFramework = 'get_it/injectable';
    else if (/provider:/i.test(pub))              info.diFramework = 'provider';
    else if (/riverpod/i.test(pub))               info.diFramework = 'riverpod';
    else if (/bloc:/i.test(pub))                  info.diFramework = 'bloc+provider';
    // Architecture from folder structure
    const dirs = await listFiles(abs, 'lib/**', { maxResults: 50 });
    const paths = (dirs.files || []).map(f => f.path);
    if (paths.some(p => /\bpresentation\b|\bui\b/i.test(p)) && paths.some(p => /\bdomain\b|\busecase\b/i.test(p)))
      info.architecture = 'clean-architecture';
    else if (paths.some(p => /\bbloc\b/i.test(p)))
      info.architecture = 'BLoC';
    else if (paths.some(p => /\bviewmodel\b/i.test(p)))
      info.architecture = 'MVVM';
    else if (paths.some(p => /\brepository\b/i.test(p)))
      info.architecture = 'repository-pattern';
  } else if (hasPkg) {
    const pkg = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    info.platform = deps['react-native'] ? 'react-native' : 'web';
    if (deps['inversify'])            info.diFramework = 'InversifyJS';
    else if (deps['tsyringe'])        info.diFramework = 'tsyringe';
    else if (deps['@nestjs/core'])  { info.diFramework = 'NestJS-DI'; info.architecture = 'NestJS (module-based)'; }
    else if (deps['awilix'])          info.diFramework = 'awilix';
    else if (deps['typedi'])          info.diFramework = 'typedi';
    // Architecture
    const dirs = await listFiles(abs, 'src/**', { maxResults: 80 });
    const paths = (dirs.files || []).map(f => f.path);
    if (paths.some(p => /usecase|use.case/i.test(p)) && paths.some(p => /repositor/i.test(p)))
      info.architecture = 'clean-architecture';
    else if (paths.some(p => /store|reducer|slice/i.test(p)))
      info.architecture = 'Redux/flux';
    else if (paths.some(p => /viewmodel/i.test(p)))
      info.architecture = 'MVVM';
    else if (pkg.scripts?.build?.includes('next'))
      info.architecture = 'Next.js';
  } else if (hasGradle) {
    info.platform = 'kotlin';
    // Check Hilt
    const gradleContent = existsSync(join(abs, 'build.gradle.kts'))
      ? readFileSync(join(abs, 'build.gradle.kts'), 'utf8')
      : existsSync(join(abs, 'build.gradle')) ? readFileSync(join(abs, 'build.gradle'), 'utf8') : '';
    if (/hilt/i.test(gradleContent))       info.diFramework = 'Hilt/Dagger';
    else if (/koin/i.test(gradleContent))  info.diFramework = 'Koin';
    else if (/dagger/i.test(gradleContent)) info.diFramework = 'Dagger2';
    // Architecture
    const dirs = await listFiles(abs, '**', { maxResults: 100 });
    const paths = (dirs.files || []).map(f => f.path);
    if (paths.some(p => /usecase|interactor/i.test(p)) && paths.some(p => /repositor/i.test(p)))
      info.architecture = 'clean-architecture';
    else if (paths.some(p => /viewmodel/i.test(p)))
      info.architecture = 'MVVM';
    else if (paths.some(p => /presenter/i.test(p)))
      info.architecture = 'MVP';
    else if (paths.some(p => /controller/i.test(p)))
      info.architecture = 'MVC';
  } else if (hasPkgSwift || hasXcodeProj) {
    info.platform = 'swift';
    const allSwift = await searchFiles('import Swinject|import Factory|import Resolver|import Needle', { path: abs, filePattern: '**/*.swift', maxResults: 5 });
    if (allSwift.count > 0) {
      const m = allSwift.matches[0]?.match?.match(/Swinject|Factory|Resolver|Needle/i)?.[0];
      if (m) info.diFramework = m;
    }
    // TCA detection — check for ComposableArchitecture import
    const tcaSearch = await searchFiles('import ComposableArchitecture|ComposableArchitecture', { path: abs, filePattern: '**/*.swift', maxResults: 3 });
    if (tcaSearch.count > 0) {
      info.diFramework = info.diFramework !== 'none' ? info.diFramework : 'ComposableArchitecture';
    }
    // Architecture — check file/folder naming
    const dirs = await listFiles(abs, '**/*.swift', { maxResults: 100 });
    const paths = (dirs.files || []).map(f => f.path);
    const swiftSrc = await searchFiles('struct.*Reducer|\.send\(.*Action|Store<.*State|ViewStore', { path: abs, filePattern: '**/*.swift', maxResults: 5 });
    if (swiftSrc.count > 0 || tcaSearch.count > 0)
      info.architecture = 'TCA';
    else if (paths.some(p => /\bUseCase\b|\bInteractor\b/i.test(p)) && paths.some(p => /\bRepository\b/i.test(p)))
      info.architecture = 'clean-architecture';
    else if (paths.some(p => /\bRouter\b|\bWireframe\b/i.test(p)) && paths.some(p => /\bInteractor\b/i.test(p)) && paths.some(p => /\bPresenter\b/i.test(p)))
      info.architecture = 'VIPER';
    else if (paths.some(p => /\bViewModel\b/i.test(p)))
      info.architecture = 'MVVM';
    else if (paths.some(p => /\bPresenter\b/i.test(p)))
      info.architecture = 'MVP';
    else if (paths.some(p => /\bCoordinator\b/i.test(p)))
      info.architecture = 'MVVM-C';
    else
      info.architecture = 'MVC';
  } else if (hasGoMod) {
    info.platform = 'go';
    const goMod = readFileSync(join(abs, 'go.mod'), 'utf8');
    if (/google\/wire/i.test(goMod))      info.diFramework = 'Wire';
    else if (/uber-go\/dig/i.test(goMod)) info.diFramework = 'dig';
    else if (/uber-go\/fx/i.test(goMod))  info.diFramework = 'Fx';
    const dirs = await listFiles(abs, '**/*.go', { maxResults: 100 });
    const paths = (dirs.files || []).map(f => f.path);
    if (paths.some(p => /\bhandler\b|\bcontroller\b/i.test(p)) && paths.some(p => /\bservice\b/i.test(p)) && paths.some(p => /\brepository\b|\bstore\b/i.test(p)))
      info.architecture = 'clean-architecture';
    else if (paths.some(p => /\bhandler\b|\bcontroller\b/i.test(p)))
      info.architecture = 'MVC';
  } else if (hasCargoToml) {
    info.platform = 'rust';
    const cargo = readFileSync(join(abs, 'Cargo.toml'), 'utf8');
    if (/axum/i.test(cargo))       info.diFramework = 'Axum State<T>';
    else if (/actix/i.test(cargo)) info.diFramework = 'actix-web Data<T>';
    const dirs = await listFiles(abs, 'src/**/*.rs', { maxResults: 100 });
    const paths = (dirs.files || []).map(f => f.path);
    if (paths.some(p => /handler|route/i.test(p)) && paths.some(p => /service/i.test(p)))
      info.architecture = 'clean-architecture';
  } else if (hasMavenPom) {
    info.platform = 'java';
    const pom = readFileSync(join(abs, 'pom.xml'), 'utf8');
    if (/spring-boot/i.test(pom))         info.diFramework = 'Spring Boot';
    else if (/spring-context/i.test(pom)) info.diFramework = 'Spring Core';
    else if (/jakarta.inject/i.test(pom)) info.diFramework = 'Jakarta EE CDI';
    else if (/dagger/i.test(pom))         info.diFramework = 'Dagger';
    const dirs = await listFiles(abs, 'src/**/*.java', { maxResults: 100 });
    const paths = (dirs.files || []).map(f => f.path);
    if (paths.some(p => /UseCase|Interactor/i.test(p)) && paths.some(p => /Repository/i.test(p)))
      info.architecture = 'clean-architecture';
    else if (paths.some(p => /Controller/i.test(p)) && paths.some(p => /Service/i.test(p)))
      info.architecture = 'MVC';
    else if (paths.some(p => /ViewModel/i.test(p)))
      info.architecture = 'MVVM';
  }

  if (info.architecture !== 'unknown') info.confidence = 'high';
  info.layers = getExpectedLayers(info.architecture);
  return info;
}

function getExpectedLayers(arch) {
  const layerMap = {
    'clean-architecture': ['presentation', 'domain (use-cases)', 'data (repositories)', 'infrastructure'],
    'MVVM':               ['view', 'viewmodel', 'model/repository'],
    'MVP':                ['view', 'presenter', 'model/repository'],
    'MVC':                ['view', 'controller', 'model'],
    'MVVM-C':             ['view', 'viewmodel', 'coordinator', 'repository'],
    'VIPER':              ['view', 'interactor', 'presenter', 'entity', 'router/wireframe'],
    'TCA':                ['view', 'reducer', 'action', 'state', 'environment/dependencies'],
    'BLoC':               ['ui/widgets', 'bloc/cubit', 'repository'],
    'Redux/flux':         ['components', 'actions', 'reducers/store', 'services'],
    'repository-pattern': ['ui', 'repository', 'data-source'],
    'NestJS (module-based)': ['controller', 'service', 'repository', 'module'],
  };
  return layerMap[arch] || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Static DI violation patterns (per platform)
// ─────────────────────────────────────────────────────────────────────────────

const DI_VIOLATIONS = {
  swift: [
    { id: 'SW-DI-01', sev: 'high',   name: 'Singleton abuse (shared instance)',
      re: /\b\w+\.shared\.\w+/g,
      description: 'Direct use of `.shared` singletons creates hidden dependencies and makes testing impossible.',
      fix: 'Inject the dependency through the initializer using a protocol:\n```swift\nprotocol UserServiceProtocol { func getUser() async -> User }\nclass ViewModel {\n  private let userService: UserServiceProtocol\n  init(userService: UserServiceProtocol = UserService.shared) { self.userService = userService }\n}\n```' },
    { id: 'SW-DI-02', sev: 'high',   name: 'Direct concrete instantiation inside class',
      re: /(?:let|var)\s+\w+\s*=\s*\w+(?:Manager|Service|Repository|Client|Helper)\(\)/g,
      description: 'Directly instantiating dependencies couples classes to concrete implementations — violates DIP.',
      fix: 'Inject via protocol in init:\n```swift\nclass OrderViewModel {\n  private let orderRepo: OrderRepositoryProtocol\n  init(orderRepo: OrderRepositoryProtocol) { self.orderRepo = orderRepo }\n}\n```' },
    { id: 'SW-DI-03', sev: 'medium', name: 'Property injection (not constructor injection)',
      re: /var\s+\w+(?:Service|Repository|Manager|Client)\s*:\s*\w+\s*[!=]/g,
      description: 'Property injection allows objects in an incomplete state — prefer constructor injection.',
      fix: 'Use `let` and inject in `init()` so all dependencies are required at construction time.' },
    { id: 'SW-DI-04', sev: 'high',   name: 'UserDefaults / Notification in business logic',
      re: /UserDefaults\.standard|NotificationCenter\.default/g,
      description: 'Direct platform globals in business logic couples it to the framework, preventing unit testing.',
      fix: 'Wrap in a protocol and inject it:\n```swift\nprotocol KeyValueStoreProtocol { func set(_ value: Any?, forKey: String) }\nextension UserDefaults: KeyValueStoreProtocol {}\n```' },
    { id: 'SW-DI-05', sev: 'medium', name: 'View instantiating ViewModel directly',
      re: /(?:@StateObject\s+var\s+\w+\s*=\s*\w+ViewModel\(\)|init\s*\(\s*\)\s*\{\s*\w+ViewModel\(\))/g,
      description: 'View owns ViewModel construction — breaks DI and testability in SwiftUI.',
      fix: 'Pass ViewModel as a parameter:\n```swift\nstruct MyView: View {\n  @StateObject var viewModel: MyViewModel\n  init(viewModel: MyViewModel = MyViewModel()) { _viewModel = StateObject(wrappedValue: viewModel) }\n}\n```' },
  ],
  kotlin: [
    { id: 'KT-DI-01', sev: 'critical', name: 'Companion object getInstance() (Singleton anti-pattern)',
      re: /(?:getInstance|instance)\s*\(\s*\)/g,
      description: 'Manual singleton prevents injection, breaks testability, and causes state leakage across tests.',
      fix: 'Replace with Hilt @Singleton:\n```kotlin\n@Singleton\nclass UserRepository @Inject constructor(\n  private val api: ApiService\n) {}\n```\nOr Koin:\n```kotlin\nsingle { UserRepository(get()) }\n```' },
    { id: 'KT-DI-02', sev: 'high', name: 'Direct instantiation in ViewModel/Repository',
      re: /=\s*\w+(?:Repository|Service|Manager|Client|Helper)\s*\(\s*\)/g,
      description: 'Newing up dependencies inside class bodies violates Dependency Inversion Principle.',
      fix: 'Use constructor injection with @Inject:\n```kotlin\n@HiltViewModel\nclass OrderViewModel @Inject constructor(\n  private val orderRepository: OrderRepository\n) : ViewModel() {}\n```' },
    { id: 'KT-DI-03', sev: 'high', name: 'Context stored in ViewModel',
      re: /ViewModel[^{]*\{[^}]*(?:private|protected|val|var)\s+\w*[Cc]ontext/g,
      description: 'Context in ViewModel causes memory leaks and ties business logic to Android framework.',
      fix: 'Use AndroidViewModel or inject Application context:\n```kotlin\n@HiltViewModel\nclass MyViewModel @Inject constructor(\n  @ApplicationContext private val context: Context\n) : ViewModel()\n```' },
    { id: 'KT-DI-04', sev: 'high', name: 'Hardwired repository in Activity/Fragment',
      re: /(?:Activity|Fragment)[^{]*\{[\s\S]*?(?:val|var)\s+\w+\s*=\s*\w+Repository\s*\(/g,
      description: 'Creating repositories in UI layer violates Clean Architecture layering.',
      fix: 'Use ViewModel with Hilt injection — never create repositories in Activity/Fragment.' },
    { id: 'KT-DI-05', sev: 'medium', name: 'Missing interface for injected dependency',
      re: /@Inject\s+constructor\s*\([^)]*:\s*(?!.*Interface|.*Protocol)\w+(?:Repository|Service|Manager)\b/g,
      description: 'Injecting concrete classes instead of interfaces breaks the Open/Closed Principle.',
      fix: 'Inject an interface and bind in a Hilt module:\n```kotlin\ninterface UserRepository { suspend fun getUser(id: String): User }\nclass UserRepositoryImpl @Inject constructor(...) : UserRepository\n```' },
    { id: 'KT-DI-06', sev: 'high', name: 'Runnable/Thread in ViewModel (no coroutines)',
      re: /ViewModel[^{]*\{[\s\S]*?Thread\s*\{|Runnable\s*\{/g,
      description: 'Raw threads bypass coroutine DI (Dispatchers) and cannot be easily tested or cancelled.',
      fix: 'Use ViewModelScope with injected Dispatcher:\n```kotlin\nclass MyViewModel @Inject constructor(\n  @IoDispatcher private val ioDispatcher: CoroutineDispatcher\n) : ViewModel() {\n  fun load() = viewModelScope.launch(ioDispatcher) { ... }\n}\n```' },
  ],
  dart: [
    { id: 'FL-DI-01', sev: 'high', name: 'Direct service instantiation in Widget',
      re: /(?:StatefulWidget|StatelessWidget|State)[^{]*\{[\s\S]*?=\s*\w+(?:Service|Repository|Client)\s*\(\s*\)/g,
      description: 'Widgets should never create their own dependencies — violates Separation of Concerns.',
      fix: 'Use get_it or Provider:\n```dart\nfinal sl = GetIt.instance;\nsl.registerLazySingleton<UserRepository>(() => UserRepositoryImpl(sl()));\n// In widget:\nfinal repo = sl<UserRepository>();\n```' },
    { id: 'FL-DI-02', sev: 'high', name: 'Static global service (anti-pattern)',
      re: /static\s+(?:final|late)?\s*\w+(?:Service|Repository|Manager)\s+\w+\s*=/g,
      description: 'Static global state is an anti-pattern — use a DI container instead.',
      fix: 'Register as singleton with get_it:\n```dart\nGetIt.I.registerSingleton<ApiService>(ApiService());\n// Access:\nGetIt.I<ApiService>()\n```' },
    { id: 'FL-DI-03', sev: 'medium', name: 'Missing interface (abstract class) for dependency',
      re: /(?:registerSingleton|registerFactory|registerLazySingleton)<(?!.*Protocol|.*Abstract)\w+(?:Repository|Service)>/g,
      description: 'Registering concrete classes instead of abstractions — violates DIP.',
      fix: 'Create an abstract class and register the implementation:\n```dart\nabstract class UserRepository { Future<User> getUser(String id); }\nclass UserRepositoryImpl implements UserRepository { ... }\nsl.registerLazySingleton<UserRepository>(() => UserRepositoryImpl());\n```' },
    { id: 'FL-DI-04', sev: 'high', name: 'BLoC/Cubit instantiated in Widget tree (not provided)',
      re: /BlocProvider\s*\(\s*create:\s*\([^)]*\)\s*=>\s*\w+Bloc\(\s*\)/g,
      description: 'Creating BLoC with empty constructor skips dependency injection.',
      fix: 'Inject dependencies into BLoC via constructor and provide from DI:\n```dart\nBlocProvider(\n  create: (ctx) => OrderBloc(repository: sl<OrderRepository>()),\n  child: ...,\n)\n```' },
    { id: 'FL-DI-05', sev: 'medium', name: 'BuildContext used in Repository/Service layer',
      re: /(?:Repository|Service|Bloc|Cubit)[^{]*\{[\s\S]*?BuildContext/g,
      description: 'BuildContext in business logic layers creates framework coupling.',
      fix: 'Pass data, not context. Use navigator keys or abstract navigation service if navigation is needed from BLoC.' },
  ],
  'react-native': [
    { id: 'RN-DI-01', sev: 'high', name: 'Direct service import (tight coupling)',
      re: /import\s+\w+(?:Service|Repository|Client|Api)\s+from/g,
      description: 'Direct imports create tight coupling — components cannot be tested with mock services.',
      fix: 'Use React Context or InversifyJS:\n```tsx\n// services/context.tsx\nexport const ServiceContext = createContext<Services>(defaultServices);\n// component:\nconst { userService } = useContext(ServiceContext);\n```' },
    { id: 'RN-DI-02', sev: 'high', name: 'new Service() inside component/hook',
      re: /(?:function\s+\w+|const\s+\w+\s*=)[^{]*\{[^}]*new\s+\w+(?:Service|Client|Repository)\s*\(/g,
      description: 'Creating service instances inside components re-creates them on every render and prevents DI.',
      fix: 'Create services once at app root and inject via Context:\n```tsx\nconst services = { userService: new UserService(httpClient) };\n<ServiceContext.Provider value={services}><App /></ServiceContext.Provider>\n```' },
    { id: 'RN-DI-03', sev: 'medium', name: 'Axios/fetch called directly in component',
      re: /(?:axios|fetch)\s*\.\s*(?:get|post|put|delete)\s*\(/g,
      description: 'API calls in components bypass the repository/service layer — violates separation of concerns.',
      fix: 'Move API calls to a service/repository layer and inject it:\n```tsx\ninterface UserRepository { getUser(id: string): Promise<User>; }\nconst useUser = (id: string) => {\n  const { userRepo } = useContext(AppContext);\n  return useQuery([\'user\', id], () => userRepo.getUser(id));\n};\n```' },
    { id: 'RN-DI-04', sev: 'medium', name: 'Redux thunk accessing service directly',
      re: /createAsyncThunk[^}]+(?:axios|fetch|new\s+\w+Service)/g,
      description: 'Services accessed directly in thunks bypass injection and prevent testing.',
      fix: 'Inject services via Redux middleware extra argument:\n```ts\nconst store = configureStore({ middleware: (g) => g({ thunk: { extraArgument: { userService } } }) });\n// thunk:\nconst thunk = createAsyncThunk(\'user/fetch\', async (id, { extra }) => extra.userService.getUser(id));\n```' },
  ],
  typescript: [
    { id: 'TS-DI-01', sev: 'high', name: 'Hardwired dependency (new inside class body)',
      re: /(?:private|protected|readonly)\s+\w+\s*=\s*new\s+\w+(?:Service|Repository|Client|Manager)\s*\(/g,
      description: 'Creating dependencies inside class bodies violates DIP and makes unit testing impossible.',
      fix: 'Use constructor injection:\n```typescript\nclass OrderService {\n  constructor(\n    private readonly repo: OrderRepository,   // interface, not concrete class\n    private readonly emailService: EmailService\n  ) {}\n}\n```' },
    { id: 'TS-DI-02', sev: 'high', name: 'Service Locator pattern (manual registry)',
      re: /(?:container|registry|locator)\.(?:get|resolve|getInstance)\s*\(\s*(?:['"`]\w+['"`]|\w+)\s*\)/g,
      description: 'Service Locator is an anti-pattern — it hides dependencies and prevents compile-time validation.',
      fix: 'Use constructor injection instead of resolving from a container inside classes. Resolve only at the composition root.' },
    { id: 'TS-DI-03', sev: 'medium', name: 'Missing interface for injected class',
      re: /constructor\s*\([^)]*:\s*\w+(?:Service|Repository|Manager|Client)\b(?!\w)/g,
      description: 'Injecting concrete classes instead of interfaces — violates Open/Closed Principle.',
      fix: 'Define an interface and inject it:\n```typescript\ninterface IUserRepository { findById(id: string): Promise<User>; }\nclass UserService { constructor(private repo: IUserRepository) {} }\n```' },
    { id: 'TS-DI-04', sev: 'medium', name: 'Singleton exported module-level (not injectable)',
      re: /export\s+(?:const|default)\s+\w+\s*=\s*new\s+\w+(?:Service|Repository|Client)/g,
      description: 'Module-level singletons cannot be overridden for testing and create hidden global state.',
      fix: 'Use a DI container (InversifyJS/tsyringe/NestJS) or factory function instead of module-level singletons.' },
    { id: 'TS-DI-05', sev: 'low', name: 'Circular dependency risk (cross-layer import)',
      re: /from\s+['"](?:\.\.\/){2,}/g,
      description: 'Deep relative imports across multiple parent directories suggest layer violations.',
      fix: 'Use absolute path aliases (tsconfig paths) and enforce layer boundaries with eslint-plugin-import.' },
  ],
  python: [
    { id: 'PY-DI-01', sev: 'high', name: 'Direct instantiation in method body',
      re: /def\s+\w+\s*\([^)]*\):[^:]*\n\s+\w+\s*=\s*\w+(?:Service|Repository|Manager|Client)\s*\(\s*\)/g,
      description: 'Instantiating dependencies inside methods violates DIP and prevents testing.',
      fix: 'Inject through __init__:\n```python\nclass OrderService:\n    def __init__(self, repo: OrderRepositoryProtocol, email: EmailServiceProtocol):\n        self._repo = repo\n        self._email = email\n```' },
    { id: 'PY-DI-02', sev: 'high', name: 'Module-level global service instance',
      re: /^(?!#)\w+\s*=\s*\w+(?:Service|Repository|Manager|Client)\s*\(\s*\)\s*$/gm,
      description: 'Module-level singletons are global state — they cannot be replaced during testing.',
      fix: 'Use a DI container (dependency-injector, pinject) or pass via function parameters.' },
    { id: 'PY-DI-03', sev: 'medium', name: 'Missing Protocol/ABC for dependency',
      re: /def\s+__init__\s*\([^)]*:\s*\w+(?:Service|Repository|Manager)\b(?!\w)/g,
      description: 'Type-hinting concrete class, not an abstract interface — violates DIP.',
      fix: 'Define a Protocol and hint against it:\n```python\nfrom typing import Protocol\nclass UserRepositoryProtocol(Protocol):\n    async def find_by_id(self, id: str) -> User: ...\nclass UserService:\n    def __init__(self, repo: UserRepositoryProtocol): ...\n```' },
    { id: 'PY-DI-04', sev: 'medium', name: 'Django ORM called directly in view/service',
      re: /(?:objects\.filter|objects\.get|objects\.create)\s*\(/g,
      description: 'Direct ORM calls in business logic bypass the repository pattern.',
      fix: 'Wrap in a repository class and inject it into services — keeps business logic DB-agnostic.' },
  ],
  java: [
    { id: 'JV-DI-01', sev: 'critical', name: 'Manual singleton getInstance() in Spring context',
      re: /\w+\.getInstance\s*\(\s*\)/g,
      description: 'Manual singletons bypass Spring DI container and prevent bean replacement in tests.',
      fix: 'Use @Component/@Service/@Repository and inject with @Autowired or constructor injection.' },
    { id: 'JV-DI-02', sev: 'high', name: 'Field injection (@Autowired on field)',
      re: /@Autowired\s+(?:private|protected|public)\s+\w+/g,
      description: 'Field injection hides dependencies and makes the class non-testable without a Spring context.',
      fix: 'Use constructor injection:\n```java\n@Service\npublic class OrderService {\n  private final OrderRepository repo;\n  public OrderService(OrderRepository repo) { this.repo = repo; }\n}\n```' },
    { id: 'JV-DI-03', sev: 'high', name: 'new Service() inside Spring bean',
      re: /=\s*new\s+\w+(?:Service|Repository|Manager|Client)\s*\(/g,
      description: 'Creating beans with new bypasses the Spring container and its lifecycle/proxy features.',
      fix: 'Inject the dependency via constructor and declare it as a @Bean or @Component.' },
    { id: 'JV-DI-04', sev: 'medium', name: 'Missing interface for Spring dependency',
      re: /@Autowired[\s\S]{0,60}(?:class|private final)\s+\w+(?:ServiceImpl|RepositoryImpl)\b/g,
      description: 'Injecting implementation class instead of interface — violates DIP and breaks proxy-based AOP.',
      fix: 'Inject the interface, not the Impl class. Spring will inject the correct implementation.' },
    { id: 'JV-DI-05', sev: 'medium', name: 'ApplicationContext used as service locator',
      re: /applicationContext\.getBean\s*\(/g,
      description: 'Pulling beans from ApplicationContext inside classes is the Service Locator anti-pattern.',
      fix: 'Declare the dependency explicitly via constructor injection — let Spring wire it automatically.' },
  ],
  go: [
    { id: 'GO-DI-01', sev: 'high', name: 'Concrete struct dependency (not interface)',
      re: /func\s+New\w+\s*\([^)]*\*\w+(?:Service|Repository|Client|Manager)\b/g,
      description: 'Constructor takes a concrete struct instead of an interface — violates DIP, prevents mocking.',
      fix: 'Define an interface and accept it:\n```go\ntype UserRepository interface { GetUser(ctx context.Context, id string) (*User, error) }\nfunc NewOrderService(repo UserRepository) *OrderService { return &OrderService{repo: repo} }\n```' },
    { id: 'GO-DI-02', sev: 'high', name: 'Package-level var (global singleton)',
      re: /^var\s+\w+\s*(?:\*\w+)?\s*=\s*(?:&\w+\{|\w+\.New)/gm,
      description: 'Package-level variables are global state — they create hidden coupling and test pollution.',
      fix: 'Pass dependencies explicitly via constructors or use Wire/dig for dependency graphs.' },
    { id: 'GO-DI-03', sev: 'medium', name: 'init() used to initialise services',
      re: /func\s+init\s*\(\s*\)\s*\{[\s\S]{0,200}(?:Service|Repository|Client)\s*\(/g,
      description: 'init() runs at import time — dependencies created here cannot be injected or overridden.',
      fix: 'Move initialisation to explicit constructor functions called from main().' },
    { id: 'GO-DI-04', sev: 'medium', name: 'HTTP handler accessing database directly',
      re: /func\s+\w+Handler[^{]*\{[\s\S]{0,300}(?:sql\.|gorm\.|db\.)/g,
      description: 'HTTP handlers should not access the database directly — route through a service/repository layer.',
      fix: 'Inject a repository interface into the handler struct:\n```go\ntype UserHandler struct { repo UserRepository }\nfunc NewUserHandler(repo UserRepository) *UserHandler { return &UserHandler{repo: repo} }\n```' },
  ],
  rust: [
    { id: 'RS-DI-01', sev: 'high', name: 'Concrete type in function signature (not trait)',
      re: /fn\s+\w+\s*\([^)]*:\s*(?:Arc<)?\w+(?:Service|Repository|Client|Manager)\b/g,
      description: 'Accepting concrete types instead of trait objects prevents mocking and reduces flexibility.',
      fix: 'Use trait objects or generics:\n```rust\nfn new_order_service<R: UserRepository>(repo: R) -> OrderService<R> { OrderService { repo } }\n// or:\nfn new_order_service(repo: Arc<dyn UserRepository>) -> OrderService { ... }\n```' },
    { id: 'RS-DI-02', sev: 'high', name: 'Lazy_static / once_cell global (hidden state)',
      re: /lazy_static!|once_cell::sync::Lazy|static\s+\w+\s*:\s*(?:Mutex|RwLock|Arc)</g,
      description: 'Global statics create hidden state that cannot be reset between tests.',
      fix: 'Pass dependencies explicitly. For async Rust use tokio\'s task-local or inject via state extractors (Axum State<T>).' },
    { id: 'RS-DI-03', sev: 'medium', name: 'Axum handler accessing DB pool directly from extension',
      re: /Extension\s*\(\s*(?:pool|db|conn)\s*\):\s*Extension</g,
      description: 'Handlers accessing DB pool directly bypass the repository layer.',
      fix: 'Wrap the pool in a repository struct, inject via Axum State<AppState> where AppState holds the repository trait object.' },
  ],
};

function getViolationsForLang(lang, platform) {
  if (lang === 'swift')  return DI_VIOLATIONS.swift;
  if (lang === 'kotlin') return DI_VIOLATIONS.kotlin;
  if (lang === 'dart')   return DI_VIOLATIONS.dart;
  if ((lang === 'typescript' || lang === 'javascript') && platform === 'react-native') return DI_VIOLATIONS['react-native'];
  if (lang === 'typescript' || lang === 'javascript') return DI_VIOLATIONS.typescript;
  if (lang === 'python') return DI_VIOLATIONS.python;
  if (lang === 'java')   return DI_VIOLATIONS.java;
  if (lang === 'go')     return DI_VIOLATIONS.go;
  if (lang === 'rust')   return DI_VIOLATIONS.rust;
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Scan a single file for DI violations
// ─────────────────────────────────────────────────────────────────────────────

const EXT_LANG = { '.swift': 'swift', '.kt': 'kotlin', '.kts': 'kotlin', '.dart': 'dart', '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust' };

export function scanFileForDIViolations(filePath, content, platform = 'unknown') {
  const lang = EXT_LANG[extname(filePath).toLowerCase()] || 'unknown';
  const patterns = getViolationsForLang(lang, platform);
  const findings = [];

  for (const p of patterns) {
    const re = new RegExp(p.re.source, p.re.flags);
    let m;
    while ((m = re.exec(content)) !== null) {
      const lineNum = content.slice(0, m.index).split('\n').length;
      const lineText = content.split('\n')[lineNum - 1]?.trim() || '';
      if (lineText.startsWith('//') || lineText.startsWith('#') || lineText.startsWith('*')) continue;
      findings.push({
        id: p.id,
        severity: p.sev,
        name: p.name,
        line: lineNum,
        code: lineText.slice(0, 120),
        description: p.description,
        fix: p.fix,
        file: filePath,
        lang,
      });
      if (findings.filter(f => f.id === p.id).length >= 3) break;
    }
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Architecture layer violation detection
// ─────────────────────────────────────────────────────────────────────────────

const LAYER_RULES = {
  'clean-architecture': {
    forbidden: [
      { from: /domain|use.?case/i,       to: /presentation|ui|view|screen|widget|activity|fragment|controller/i, msg: 'Domain layer must NOT depend on Presentation layer' },
      { from: /domain|use.?case/i,       to: /data|repository.?impl|network|database|local/i,                   msg: 'Domain layer must NOT depend on Data layer (only on Repository interfaces)' },
      { from: /presentation|viewmodel/i, to: /database|dao|room|sqflite|realm/i,                                 msg: 'Presentation layer must NOT access Database directly — go through Repository' },
    ],
    required: [
      { in: /use.?case|interactor/i, shouldHave: /repository|datasource/i, msg: 'UseCases should depend on Repository interfaces' },
      { in: /viewmodel|presenter/i,  shouldHave: /use.?case|interactor/i,  msg: 'ViewModels/Presenters should call UseCases, not Repositories directly' },
    ],
  },
  'MVVM': {
    forbidden: [
      { from: /viewmodel/i, to: /view|widget|activity|fragment|\.swift.*UI|SwiftUI/i, msg: 'ViewModel must NOT reference View/UI types' },
      { from: /model|repository/i, to: /viewmodel/i, msg: 'Model/Repository must NOT depend on ViewModel' },
    ],
  },
  'VIPER': {
    forbidden: [
      { from: /presenter/i, to: /router|wireframe/i,  msg: 'Presenter must NOT navigate directly — use Router/Wireframe' },
      { from: /interactor/i, to: /view|presenter/i,   msg: 'Interactor must NOT reference View or Presenter' },
      { from: /view/i,       to: /interactor|entity/i, msg: 'View must NOT access Interactor or Entity directly — go through Presenter' },
      { from: /entity/i,     to: /interactor|presenter|router|view/i, msg: 'Entity must be a plain data model — no dependencies on other VIPER layers' },
    ],
    required: [
      { in: /presenter/i,   shouldHave: /interactor/i, msg: 'Presenter should hold a reference to Interactor' },
      { in: /presenter/i,   shouldHave: /router|wireframe/i, msg: 'Presenter should hold a reference to Router/Wireframe' },
      { in: /interactor/i,  shouldHave: /entity/i,     msg: 'Interactor should work with Entities' },
    ],
  },
  'TCA': {
    forbidden: [
      { from: /reducer/i, to: /view|swiftui|uikit/i, msg: 'Reducer must NOT reference View/SwiftUI types — keep it pure' },
      { from: /view/i,    to: /environment|dependency/i, msg: 'View must NOT access Environment/Dependencies directly — route through Store/ViewStore' },
    ],
    required: [
      { in: /reducer/i, shouldHave: /action|state/i, msg: 'Reducer should define Action and State types' },
      { in: /view/i,    shouldHave: /store|viewstore/i, msg: 'TCA Views should use Store or ViewStore' },
    ],
  },
  'BLoC': {
    forbidden: [
      { from: /bloc|cubit/i, to: /widget|build.*context|scaffold|navigator/i, msg: 'BLoC/Cubit must NOT reference Flutter widgets or BuildContext' },
    ],
  },
};

export async function detectLayerViolations(projectPath = '.', architecture) {
  if (!architecture || !LAYER_RULES[architecture]) return { violations: [], architecture };

  const abs = resolve(projectPath);
  const rules = LAYER_RULES[architecture];
  const violations = [];

  // Get all source files with their import relationships
  const allFiles = await listFiles(abs, '**/*.{swift,kt,dart,ts,tsx,js,jsx,py}', { maxResults: 200 });

  for (const f of (allFiles.files || []).slice(0, 100)) {
    if (f.type !== 'file') continue;
    const fabs = join(abs, f.path);
    let content;
    try { content = readFileSync(fabs, 'utf8'); } catch { continue; }

    // Extract imports
    const importRe = /import\s+['"`]([^'"`]+)['"`]|import\s+(\S+)|from\s+['"`]([^'"`]+)['"`]\s+import/g;
    const imports = [];
    let im;
    while ((im = importRe.exec(content)) !== null) imports.push(im[1] || im[2] || im[3] || '');

    // Check forbidden dependencies
    for (const rule of (rules.forbidden || [])) {
      if (rule.from.test(f.path)) {
        for (const imp of imports) {
          if (rule.to.test(imp)) {
            violations.push({ type: 'layer-violation', severity: 'high', file: f.path, import: imp, rule: rule.msg, description: `${f.path} imports ${imp} — ${rule.msg}` });
          }
        }
      }
    }
  }

  return { violations, architecture, filesChecked: (allFiles.files || []).length };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. LLM deep DI analysis
// ─────────────────────────────────────────────────────────────────────────────

const DI_REVIEW_PROMPT = `You are an expert software architect specialising in Dependency Injection patterns and mobile/web architecture.

Analyse the provided code for DI correctness and architecture conformance.

Supported architectures — apply pattern-specific rules:
- **MVVM**: ViewModel must not reference View/UI types. Model/Repository must not depend on ViewModel.
- **VIPER**: View↔Presenter↔Interactor↔Entity, Router handles navigation. Each layer only talks to its neighbour.
- **TCA (The Composable Architecture)**: Reducer must be pure (no View references). Views use Store/ViewStore only. Dependencies via Environment/DependencyValues.
- **Clean Architecture**: Domain layer has no UI or Data dependencies. UseCases depend on Repository interfaces only.
- **BLoC**: Bloc/Cubit must not reference Flutter widgets or BuildContext.
- **MVC/MVP/MVVM-C**: apply standard layer direction rules.

Check ALL of the following:
1. **DI Pattern correctness** — Constructor vs property injection, is the right pattern used?
2. **Dependency Inversion Principle (DIP)** — Are high-level modules depending on abstractions (interfaces/protocols), not concrete classes?
3. **Circular dependencies** — Do any classes depend on each other in a cycle?
4. **Service Locator anti-pattern** — Are dependencies resolved from a registry inside business logic?
5. **Singleton abuse** — Are global singletons used where injection should be?
6. **Layer violations** — Are dependencies flowing in the correct direction for the detected architecture?
7. **Testability** — Can all dependencies be mocked/stubbed for unit testing?
8. **Missing abstractions** — Should any concrete type be replaced with an interface/protocol?
9. **Over-injection** — Classes with too many injected deps (>4) — suggest decomposition
10. **Framework-specific** — Correct use of Hilt/Koin/Provider/Riverpod/InversifyJS/get_it/ComposableArchitecture

For each issue found, provide:
- The exact problem
- WHY it violates DI/architecture principles
- The COMPLETE, BEST fix with corrected code

Return ONLY valid JSON:
{
  "overallAssessment": "2-3 sentence assessment",
  "diPatternDetected": "constructor-injection|property-injection|service-locator|none",
  "architectureConformance": "conformant|partial|non-conformant",
  "grade": "A|B|C|D|F",
  "violations": [
    {
      "id": "unique-id",
      "severity": "critical|high|medium|low",
      "principle": "DIP|SRP|OCP|ISP|LSP|DI|Layer|Testability|Circular|VIPER|TCA|MVVM",
      "name": "Short violation name",
      "description": "What is wrong",
      "currentCode": "problematic snippet",
      "fix": "complete corrected code",
      "explanation": "why this is the best fix"
    }
  ],
  "strengths": ["what DI is done well"],
  "recommendations": ["broader architectural recommendations"]
}`;

export async function analyzeDIWithLLM(filePath, content, archInfo) {
  const lang = EXT_LANG[extname(filePath).toLowerCase()] || 'code';
  const contextStr = archInfo ? `Architecture: ${archInfo.architecture}, DI Framework: ${archInfo.diFramework}, Platform: ${archInfo.platform}` : '';

  const chat = await getChat();
  const response = await chat({
    messages: [
      { role: 'system', content: DI_REVIEW_PROMPT },
      { role: 'user', content: `${contextStr}\n\nFile: ${basename(filePath)}\n\n\`\`\`${lang}\n${content.slice(0, 10000)}\n\`\`\`` },
    ],
  });

  try {
    const match = response.content.match(/```json\s*([\s\S]+?)```/) || response.content.match(/\{[\s\S]+\}/);
    const raw = match ? (match[1] || match[0]) : response.content;
    return JSON.parse(raw.trim());
  } catch {
    return { overallAssessment: 'LLM review parse error', grade: '?', violations: [], raw: response.content.slice(0, 500) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Full project DI analysis
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeDI(projectPath = '.', { llm = true, maxFiles = 15 } = {}) {
  const abs = resolve(projectPath);
  printTool(`DI analysis: ${abs}`);

  // Step 1: Detect architecture
  const archInfo = await detectArchitecture(abs);
  printTool(`Architecture: ${archInfo.architecture} | DI: ${archInfo.diFramework} | Platform: ${archInfo.platform}`);

  // Step 2: Static scan all source files
  const extMap = { swift: '**/*.swift', kotlin: '**/*.{kt,kts}', flutter: '**/*.dart', 'react-native': '**/*.{ts,tsx,js,jsx}', web: '**/*.{ts,tsx,js,jsx}', python: '**/*.py', unknown: '**/*.{ts,tsx,js,py,swift,kt,dart}' };
  const filePattern = extMap[archInfo.platform] || extMap.unknown;
  const allFiles = await listFiles(abs, filePattern, { maxResults: 300 });
  const sourceFiles = (allFiles.files || []).filter(f => f.type === 'file');

  let totalStaticFindings = [];
  const fileResults = [];

  for (const f of sourceFiles.slice(0, 50)) {
    const fabs = join(abs, f.path);
    let content;
    try { content = readFileSync(fabs, 'utf8'); } catch { continue; }
    const findings = scanFileForDIViolations(fabs, content, archInfo.platform);
    if (findings.length > 0) {
      totalStaticFindings.push(...findings);
      fileResults.push({ file: f.path, findings, findingCount: findings.length });
    }
  }

  // Step 3: Layer violation detection
  const layerResult = await detectLayerViolations(abs, archInfo.architecture);

  // Step 4: LLM deep analysis on worst files (most violations)
  const llmResults = [];
  if (llm) {
    const worstFiles = [...fileResults].sort((a, b) => b.findingCount - a.findingCount).slice(0, Math.min(maxFiles, 5));
    for (const wf of worstFiles) {
      const fabs = join(abs, wf.file);
      let content;
      try { content = readFileSync(fabs, 'utf8'); } catch { continue; }
      printTool(`LLM DI analysis: ${wf.file}`);
      try {
        const llmResult = await analyzeDIWithLLM(fabs, content, archInfo);
        llmResults.push({ file: wf.file, ...llmResult });
      } catch (e) {
        printWarn(`LLM analysis failed for ${wf.file}: ${e.message}`);
      }
    }
  }

  // Step 5: Compute overall grade
  const allFindings = [...totalStaticFindings, ...layerResult.violations];
  const criticals = allFindings.filter(f => f.severity === 'critical').length;
  const highs = allFindings.filter(f => f.severity === 'high').length;
  const score = criticals * 40 + highs * 20 + allFindings.filter(f => f.severity === 'medium').length * 10;
  const grade = score === 0 ? 'A' : score < 20 ? 'B' : score < 60 ? 'C' : score < 120 ? 'D' : 'F';

  return {
    projectPath: abs,
    architecture: archInfo.architecture,
    diFramework: archInfo.diFramework,
    platform: archInfo.platform,
    expectedLayers: archInfo.layers,
    grade,
    filesScanned: sourceFiles.length,
    totalViolations: allFindings.length,
    criticals,
    highs,
    staticFindings: totalStaticFindings.slice(0, 50),
    layerViolations: layerResult.violations,
    fileResults: fileResults.slice(0, 20),
    llmAnalysis: llmResults,
    recommendations: buildRecommendations(archInfo, allFindings, grade),
  };
}

function buildRecommendations(archInfo, findings, grade) {
  const recs = [];
  const { architecture, diFramework, platform } = archInfo;

  if (diFramework === 'none') {
    const frameworkRec = { swift: 'Consider Factory, Swinject, or manual constructor injection with a Composition Root', kotlin: 'Use Hilt (recommended for Android) or Koin for dependency injection', flutter: 'Use get_it + injectable or Riverpod for DI', 'react-native': 'Use React Context + custom hooks, or InversifyJS for complex apps', web: 'Use InversifyJS, tsyringe, or NestJS built-in DI', python: 'Use dependency-injector library or manual constructor injection' }[platform];
    if (frameworkRec) recs.push(`No DI framework detected. ${frameworkRec}`);
  }

  if (architecture === 'unknown') recs.push('Define a clear architecture (Clean Architecture or MVVM recommended) to enforce dependency direction');
  if (findings.some(f => f.name?.includes('Singleton'))) recs.push('Replace Singletons with properly scoped DI registrations (singleton scope in container vs global state)');
  if (findings.some(f => f.name?.includes('interface') || f.name?.includes('Protocol'))) recs.push('Create interfaces/protocols for all injected dependencies to enable mocking in tests');
  if (findings.some(f => f.name?.includes('layer') || f.name?.includes('Layer'))) recs.push('Enforce layer boundaries: only depend inward (Presentation → Domain ← Data)');
  if (grade === 'F' || grade === 'D') recs.push('Consider a DI refactor sprint — high violation count indicates significant technical debt');
  if (archInfo.architecture === 'clean-architecture') recs.push('Ensure each UseCase has exactly one responsibility (SRP) and depends only on Repository interfaces (DIP)');

  return recs;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Render DI report
// ─────────────────────────────────────────────────────────────────────────────

export function renderDIReport(result) {
  const lines = [];
  const gradeColor = { A: chalk.green, B: chalk.greenBright, C: chalk.yellow, D: chalk.red, F: chalk.bold.red }[result.grade] || chalk.white;
  const sevColor = { critical: chalk.bold.red, high: chalk.red, medium: chalk.yellow, low: chalk.gray };

  lines.push('');
  lines.push(chalk.bold.cyan('╔══════════════════════════════════════════════════════════════╗'));
  lines.push(chalk.bold.cyan('║          Dependency Injection Architecture Analysis           ║'));
  lines.push(chalk.bold.cyan('╚══════════════════════════════════════════════════════════════╝'));
  lines.push('');
  lines.push(`  Architecture : ${chalk.cyan(result.architecture)}`);
  lines.push(`  DI Framework : ${chalk.cyan(result.diFramework || 'none detected')}`);
  lines.push(`  Platform     : ${chalk.cyan(result.platform)}`);
  lines.push(`  DI Grade     : ${gradeColor(`  ${result.grade}  `)}  |  Violations: ${result.totalViolations}  |  Critical: ${chalk.red(result.criticals)}  High: ${chalk.yellow(result.highs)}`);

  if (result.expectedLayers?.length) {
    lines.push(`  Expected layers: ${chalk.gray(result.expectedLayers.join(' → '))}`);
  }
  lines.push('');

  // Static findings grouped by file
  if (result.fileResults?.length) {
    lines.push(chalk.bold('DI Violations by File:'));
    lines.push('─'.repeat(65));
    for (const fr of result.fileResults.slice(0, 10)) {
      lines.push(`\n  📄 ${chalk.cyan(fr.file)} (${fr.findingCount} violations)`);
      for (const f of fr.findings) {
        const s = sevColor[f.severity] || chalk.white;
        lines.push(`    ${s(`[${f.severity.toUpperCase()}]`)} ${chalk.bold(f.name)}  ${chalk.gray(`line ${f.line}`)}`);
        lines.push(`    ${chalk.gray(f.description)}`);
        if (f.fix) {
          lines.push(`    ${chalk.green('✦ Fix:')} ${chalk.green(f.fix.split('\n')[0].slice(0, 100))}`);
        }
      }
    }
  }

  // Layer violations
  if (result.layerViolations?.length) {
    lines.push('\n' + chalk.bold.red('⚠ Architecture Layer Violations:'));
    for (const v of result.layerViolations) {
      lines.push(`  ${chalk.red(`[${v.severity.toUpperCase()}]`)} ${v.rule}`);
      lines.push(`    ${chalk.gray(v.file)} imports ${chalk.yellow(v.import)}`);
    }
  }

  // LLM analysis
  for (const lr of (result.llmAnalysis || [])) {
    if (!lr.violations?.length && !lr.overallAssessment) continue;
    lines.push(`\n${chalk.bold.blue('🤖 LLM Analysis:')} ${chalk.cyan(lr.file)}`);
    if (lr.overallAssessment) lines.push(chalk.italic.gray(`  ${lr.overallAssessment}`));
    if (lr.diPatternDetected) lines.push(chalk.gray(`  DI pattern: ${lr.diPatternDetected} | Conformance: ${lr.architectureConformance}`));
    for (const v of (lr.violations || []).slice(0, 5)) {
      const s = sevColor[v.severity] || chalk.white;
      lines.push(`\n  ${s(`[${v.severity?.toUpperCase()}]`)} ${chalk.bold(v.name)} ${chalk.gray(`(${v.principle})`)}`);
      if (v.description) lines.push(`  ${chalk.white(v.description)}`);
      if (v.currentCode) lines.push(`  ${chalk.red('Before:')} ${chalk.red(v.currentCode.split('\n')[0].slice(0, 100))}`);
      if (v.fix) {
        const fixLines = v.fix.split('\n').slice(0, 4);
        lines.push(`  ${chalk.green('After:')}  ${chalk.green(fixLines[0].slice(0, 100))}`);
        for (const fl of fixLines.slice(1)) lines.push(`           ${chalk.green(fl.slice(0, 100))}`);
      }
    }
    if (lr.strengths?.length) {
      lines.push(`\n  ${chalk.green('✓ Strengths:')}`);
      for (const s of lr.strengths) lines.push(`    ${chalk.green('•')} ${s}`);
    }
  }

  // Recommendations
  if (result.recommendations?.length) {
    lines.push('\n' + chalk.bold.cyan('💡 DI Recommendations:'));
    for (const r of result.recommendations) lines.push(`  ${chalk.cyan('→')} ${r}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Platform-wise DI correctness check
// Verdict per platform: PASS / WARN / FAIL with violation counts and fixes
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_FILE_PATTERNS = {
  swift:          '**/*.swift',
  kotlin:         '**/*.{kt,kts}',
  flutter:        '**/*.dart',
  'react-native': '**/*.{ts,tsx,js,jsx}',
  web:            '**/*.{ts,tsx,js,jsx}',
  python:         '**/*.py',
};

const PLATFORM_LANG_KEY = {
  swift: 'swift',
  kotlin: 'kotlin',
  flutter: 'dart',
  'react-native': 'react-native',
  web: 'typescript',
  python: 'python',
};

function verdictFor(criticals, highs, mediums) {
  if (criticals > 0 || highs > 2) return 'FAIL';
  if (highs > 0 || mediums > 3)   return 'WARN';
  return 'PASS';
}

// Check DI correctness for one platform (or auto-detect); platform='all' scans every platform found.
export async function checkDICorrectness(projectPath = '.', platform = 'auto') {
  const abs = resolve(projectPath);
  const archInfo = await detectArchitecture(abs);

  let platforms;
  if (platform === 'all') {
    platforms = Object.keys(PLATFORM_FILE_PATTERNS);
  } else if (platform === 'auto' || !platform) {
    platforms = [archInfo.platform !== 'unknown' ? archInfo.platform : 'web'];
  } else {
    platforms = [platform];
  }

  const results = [];
  for (const plat of platforms) {
    const pattern = PLATFORM_FILE_PATTERNS[plat];
    if (!pattern) {
      results.push({ platform: plat, verdict: 'SKIP', reason: `Unknown platform: ${plat}` });
      continue;
    }

    const listing = await listFiles(abs, pattern, { maxResults: 300 });
    const sourceFiles = (listing.files || []).filter(f =>
      f.type === 'file' && !/node_modules|\.git|build\/|dist\/|Pods\//.test(f.path));

    if (sourceFiles.length === 0) {
      if (platform === 'all') continue;   // silently skip absent platforms in all mode
      results.push({ platform: plat, verdict: 'SKIP', reason: 'No source files found for this platform' });
      continue;
    }

    const findings = [];
    for (const f of sourceFiles.slice(0, 80)) {
      let content;
      try { content = readFileSync(join(abs, f.path), 'utf8'); } catch { continue; }
      // Force platform-specific rules via a synthetic path check
      const lang = PLATFORM_LANG_KEY[plat];
      const patterns = getViolationsForLang(lang === 'react-native' ? 'typescript' : lang, plat);
      for (const p of patterns) {
        const re = new RegExp(p.re.source, p.re.flags);
        let m; let count = 0;
        while ((m = re.exec(content)) !== null && count < 3) {
          const lineNum = content.slice(0, m.index).split('\n').length;
          const lineText = content.split('\n')[lineNum - 1]?.trim() || '';
          if (lineText.startsWith('//') || lineText.startsWith('#') || lineText.startsWith('*')) continue;
          findings.push({
            id: p.id, severity: p.sev, name: p.name,
            file: f.path, line: lineNum,
            code: lineText.slice(0, 120),
            fix: p.fix,
          });
          count++;
        }
      }
    }

    const criticals = findings.filter(f => f.severity === 'critical').length;
    const highs     = findings.filter(f => f.severity === 'high').length;
    const mediums   = findings.filter(f => f.severity === 'medium').length;
    const verdict   = verdictFor(criticals, highs, mediums);

    results.push({
      platform: plat,
      verdict,
      correct: verdict === 'PASS',
      filesScanned: sourceFiles.length,
      violations: { critical: criticals, high: highs, medium: mediums, total: findings.length },
      diFramework: plat === archInfo.platform ? archInfo.diFramework : undefined,
      architecture: plat === archInfo.platform ? archInfo.architecture : undefined,
      topFindings: findings.slice(0, 10),
      recommendation: verdict === 'PASS'
        ? 'DI usage looks correct for this platform.'
        : `Fix ${criticals} critical / ${highs} high violations first. Use analyze_di for full report with fixes.`,
    });
  }

  const overall = results.every(r => r.verdict === 'PASS' || r.verdict === 'SKIP') ? 'PASS'
                : results.some(r => r.verdict === 'FAIL') ? 'FAIL' : 'WARN';

  return {
    projectPath: abs,
    overallVerdict: overall,
    diCorrect: overall === 'PASS',
    platformsChecked: results.filter(r => r.verdict !== 'SKIP').length,
    results,
  };
}
