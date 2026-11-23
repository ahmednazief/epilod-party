#[cfg(windows)]
mod imp {
    use std::mem::size_of;
    use std::ptr::null;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    static KILL_JOB: OnceLock<Option<usize>> = OnceLock::new();

    pub(crate) fn get_or_init_job_handle() -> Option<HANDLE> {
        let raw = *KILL_JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(job);
                return None;
            }
            Some(job as usize)
        });
        raw.map(|addr| addr as HANDLE)
    }

    pub fn assign_pid_to_kill_job(pid: u32) {
        if pid == 0 {
            return;
        }
        let Some(job) = get_or_init_job_handle() else {
            return;
        };
        unsafe {
            let proc_handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if proc_handle.is_null() {
                return;
            }
            let _ = AssignProcessToJobObject(job, proc_handle);
            CloseHandle(proc_handle);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn assign_pid_to_kill_job(_pid: u32) {}
}

pub use imp::assign_pid_to_kill_job;

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn job_object_initializes_on_windows() {
        assert!(super::imp::get_or_init_job_handle().is_some());
    }
}
