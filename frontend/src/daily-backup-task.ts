import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { runDailyAutoBackup } from "@/src/auto-backup";

export const DAILY_BACKUP_TASK = "surgical-store-daily-backup";

TaskManager.defineTask(DAILY_BACKUP_TASK, async () => {
  try {
    await runDailyAutoBackup();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerDailyBackupTask() {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return false;

    const registered = await TaskManager.isTaskRegisteredAsync(DAILY_BACKUP_TASK);
    if (!registered) {
      await BackgroundTask.registerTaskAsync(DAILY_BACKUP_TASK, {
        minimumInterval: 12 * 60,
      });
    }
    return true;
  } catch {
    return false;
  }
}
