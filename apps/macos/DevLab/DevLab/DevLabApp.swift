import SwiftUI

@main
struct DevLabApp: App {
    @State private var agentService = AgentService()
    @State private var appState = AppState()
    @State private var authService = AuthService()

    var body: some Scene {
        WindowGroup {
            Group {
                if authService.isSignedIn {
                    ContentView()
                        .environment(agentService)
                        .environment(appState)
                        .preferredColorScheme(.dark)   // app surfaces are dark → keep text white
                        .frame(minWidth: 1100, minHeight: 700)
                        .onAppear { agentService.startServer() }
                        .onDisappear {
                            appState.persistSession()
                            agentService.stopServer()
                            appState.terminal.stop()
                        }
                } else {
                    AuthView()
                        .environment(authService)
                }
            }
            .environment(authService)
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified(showsTitle: true))
        .commands {
            CommandGroup(replacing: .newItem) { }
            CommandMenu("Project") {
                Button("Open Folder…") {
                    appState.showFolderPicker = true
                }
                .keyboardShortcut("o", modifiers: .command)
                .disabled(!authService.isSignedIn)

                Button("New Chat Session") {
                    agentService.newSession()
                }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(!authService.isSignedIn)

                Divider()

                Button("Sign Out") {
                    authService.signOut()
                }
                .disabled(!authService.isSignedIn)
            }
        }
    }
}

