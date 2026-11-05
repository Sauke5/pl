if (import.meta.env.VITE_DOSKA_MODE === "platform") {
  void import("./doska/mount");
} else {
  void import("./native-main");
}
