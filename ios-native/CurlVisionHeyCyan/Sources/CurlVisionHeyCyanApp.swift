import SwiftUI

@main
struct CurlVisionHeyCyanApp: App {
    @StateObject private var model = WorkoutViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
        }
    }
}
