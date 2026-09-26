//! Runs a bot's shell command with less authority than the app that asked for it.
//!
//! WHY THIS EXISTS. `Shell` in Halo was real PowerShell with the user's full rights, and the box was
//! a folder rather than a boundary: `host/policy.ts` could make an escape *visible* by reading the
//! command text, but a determined model writes the same command a hundred ways and no list catches
//! them all. The boundary has to be the process, not the regex.
//!
//! WHAT IT DOES. Four Win32 primitives, in this order:
//!
//!   1. A restricted token, derived from our own: every privilege dropped except the handful a
//!      program needs to start, and the Administrators group marked deny-only, so an elevated Halo
//!      does not hand a bot elevation.
//!   2. That token lowered to **Low integrity**. Windows' mandatory integrity control then refuses
//!      writes to anything at Medium — which is the user's whole profile, their documents, the
//!      registry hives that matter, and Halo's own data directory. Reads are unaffected, because
//!      most objects carry no no-read-up policy; this stops destruction and exfiltration-by-write,
//!      not looking.
//!   3. A job object holding the child, with kill-on-close, a process cap and a memory cap, so a
//!      fork bomb takes itself down with the job and a runaway allocation cannot take the machine
//!      with it.
//!   4. A window station and desktop of its own, labelled Low, so the child can start in any
//!      session (a service or CI runner as much as a logged-in desktop) and cannot see or message
//!      the windows on the user's desktop.
//!
//! The box directory is made writable to Low integrity by the caller (`icacls … /setintegritylevel`),
//! so the bot keeps a place to work. Everything else is read-only to it as far as the kernel is
//! concerned, whatever the command says.
//!
//! WHAT IT IS NOT. Not a sandbox in the AppContainer sense: no network isolation, no separate
//! namespace, and a Low-integrity process can still read most of the user's files. It removes the
//! ability to *change* things outside the box, which is the half that is not recoverable.
//!
//! Usage: `halo-box.exe --cwd <dir> [--timeout-ms N] -- <command …>`
//! The command is handed to `powershell.exe -NoProfile -NonInteractive`. stdout and stderr are the
//! parent's own handles, so the caller reads them exactly as it read PowerShell's before.

#![cfg(windows)]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::process::exit;

type Handle = *mut core::ffi::c_void;
type Dword = u32;
type Bool = i32;

const NULL: Handle = core::ptr::null_mut();
const TRUE: Bool = 1;
const FALSE: Bool = 0;

const TOKEN_DUPLICATE: Dword = 0x0002;
const TOKEN_QUERY: Dword = 0x0008;
const TOKEN_ASSIGN_PRIMARY: Dword = 0x0001;
const TOKEN_ADJUST_DEFAULT: Dword = 0x0080;
const TOKEN_ADJUST_SESSIONID: Dword = 0x0100;
const TOKEN_ALL_NEEDED: Dword =
    TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID;

const DISABLE_MAX_PRIVILEGE: Dword = 0x1;
const SECURITY_IMPERSONATION: Dword = 2;
const TOKEN_PRIMARY: Dword = 1;
const TOKEN_INTEGRITY_LEVEL: Dword = 25;
const SE_GROUP_INTEGRITY: Dword = 0x00000020;

const CREATE_UNICODE_ENVIRONMENT: Dword = 0x0000_0400;
const CREATE_SUSPENDED: Dword = 0x0000_0004;
const CREATE_NO_WINDOW: Dword = 0x0800_0000;
const STARTF_USESTDHANDLES: Dword = 0x0000_0100;

const STD_INPUT_HANDLE: Dword = -10i32 as Dword;
const STD_OUTPUT_HANDLE: Dword = -11i32 as Dword;
const STD_ERROR_HANDLE: Dword = -12i32 as Dword;

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: Dword = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x0000_2000;
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: Dword = 0x0000_0008;
const JOB_OBJECT_LIMIT_PROCESS_MEMORY: Dword = 0x0000_0100;

const INFINITE: Dword = 0xFFFF_FFFF;
const WAIT_TIMEOUT: Dword = 258;

/// The bot's shell may fan out — npm spawns node, git spawns ssh — but not without limit.
const MAX_PROCESSES: Dword = 64;
/// Enough for a real toolchain, not enough to take the machine down by allocating.
const MAX_PROCESS_MEMORY: usize = 4 * 1024 * 1024 * 1024;

#[repr(C)]
struct SidAndAttributes {
    sid: *mut core::ffi::c_void,
    attributes: Dword,
}

#[repr(C)]
struct TokenMandatoryLabel {
    label: SidAndAttributes,
}

#[repr(C)]
struct StartupInfoW {
    cb: Dword,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: Dword,
    y: Dword,
    x_size: Dword,
    y_size: Dword,
    x_count_chars: Dword,
    y_count_chars: Dword,
    fill_attribute: Dword,
    flags: Dword,
    show_window: u16,
    cb_reserved2: u16,
    lp_reserved2: *mut u8,
    std_input: Handle,
    std_output: Handle,
    std_error: Handle,
}

#[repr(C)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    process_id: Dword,
    thread_id: Dword,
}

#[repr(C)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: Dword,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: Dword,
    affinity: usize,
    priority_class: Dword,
    scheduling_class: Dword,
}

#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn GetStdHandle(which: Dword) -> Handle;
    fn CloseHandle(handle: Handle) -> Bool;
    fn CreateJobObjectW(attributes: *mut core::ffi::c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: Dword, info: *mut core::ffi::c_void, len: Dword) -> Bool;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
    fn ResumeThread(thread: Handle) -> Dword;
    fn WaitForSingleObject(handle: Handle, ms: Dword) -> Dword;
    fn GetExitCodeProcess(process: Handle, code: *mut Dword) -> Bool;
    fn TerminateProcess(process: Handle, code: Dword) -> Bool;
    fn GetLastError() -> Dword;
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: Handle, access: Dword, token: *mut Handle) -> Bool;
    fn CreateRestrictedToken(
        existing: Handle,
        flags: Dword,
        disable_sid_count: Dword,
        sids_to_disable: *mut SidAndAttributes,
        delete_privilege_count: Dword,
        privileges_to_delete: *mut core::ffi::c_void,
        restricted_sid_count: Dword,
        sids_to_restrict: *mut SidAndAttributes,
        new_token: *mut Handle,
    ) -> Bool;
    fn DuplicateTokenEx(
        existing: Handle,
        access: Dword,
        attributes: *mut core::ffi::c_void,
        level: Dword,
        token_type: Dword,
        new_token: *mut Handle,
    ) -> Bool;
    fn SetTokenInformation(token: Handle, class: Dword, info: *mut core::ffi::c_void, len: Dword) -> Bool;
    fn ConvertStringSidToSidW(sid: *const u16, out: *mut *mut core::ffi::c_void) -> Bool;
    fn CreateProcessAsUserW(
        token: Handle,
        application: *const u16,
        command_line: *mut u16,
        process_attributes: *mut core::ffi::c_void,
        thread_attributes: *mut core::ffi::c_void,
        inherit_handles: Bool,
        creation_flags: Dword,
        environment: *mut core::ffi::c_void,
        current_directory: *const u16,
        startup_info: *mut StartupInfoW,
        process_information: *mut ProcessInformation,
    ) -> Bool;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl: *const u16,
        revision: Dword,
        descriptor: *mut *mut core::ffi::c_void,
        size: *mut Dword,
    ) -> Bool;
    fn GetSecurityDescriptorSacl(
        descriptor: *mut core::ffi::c_void,
        present: *mut Bool,
        sacl: *mut *mut core::ffi::c_void,
        defaulted: *mut Bool,
    ) -> Bool;
    fn SetSecurityInfo(
        handle: Handle,
        object_type: Dword,
        information: Dword,
        owner: *mut core::ffi::c_void,
        group: *mut core::ffi::c_void,
        dacl: *mut core::ffi::c_void,
        sacl: *mut core::ffi::c_void,
    ) -> Dword;
}

#[repr(C)]
struct SecurityAttributes {
    length: Dword,
    descriptor: *mut core::ffi::c_void,
    inherit: Bool,
}

#[link(name = "user32")]
extern "system" {
    fn GetProcessWindowStation() -> Handle;
    fn GetUserObjectInformationW(object: Handle, index: i32, info: *mut core::ffi::c_void, length: Dword, needed: *mut Dword) -> Bool;
    fn SetProcessWindowStation(station: Handle) -> Bool;
    fn CreateWindowStationW(name: *const u16, flags: Dword, access: Dword, attributes: *mut SecurityAttributes) -> Handle;
    fn CreateDesktopW(
        name: *const u16,
        device: *const u16,
        mode: *mut core::ffi::c_void,
        flags: Dword,
        access: Dword,
        attributes: *mut SecurityAttributes,
    ) -> Handle;
}

const GENERIC_ALL: Dword = 0x1000_0000;
const WINSTA_ALL_ACCESS: Dword = 0x0000_037F;
const UOI_NAME: i32 = 2;
const SDDL_REVISION_1: Dword = 1;
const SE_WINDOW_OBJECT: Dword = 7;
const LABEL_SECURITY_INFORMATION: Dword = 0x0000_0010;

/// Parses an SDDL string, failing the helper if it does not parse.
unsafe fn descriptor(sddl: &str) -> *mut core::ffi::c_void {
    let text = wide(sddl);
    let mut descriptor: *mut core::ffi::c_void = core::ptr::null_mut();
    if ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), SDDL_REVISION_1, &mut descriptor, core::ptr::null_mut()) == FALSE {
        fail("ConvertStringSecurityDescriptorToSecurityDescriptor");
    }
    descriptor
}

/// Lowers a window object to Low integrity (no-write-up) after it exists.
///
/// The label cannot ride in the descriptor passed at creation: CreateWindowStation refuses a SACL
/// from an unprivileged caller with ACCESS_DENIED. Setting it afterwards needs only WRITE_OWNER on
/// our own object, and lowering a label below our own integrity is always allowed.
unsafe fn label_low(object: Handle, what: &str) {
    let low = descriptor("S:(ML;;NW;;;LW)");
    let mut present: Bool = FALSE;
    let mut defaulted: Bool = FALSE;
    let mut sacl: *mut core::ffi::c_void = core::ptr::null_mut();
    if GetSecurityDescriptorSacl(low, &mut present, &mut sacl, &mut defaulted) == FALSE || present == FALSE {
        fail("GetSecurityDescriptorSacl");
    }
    let status = SetSecurityInfo(
        object,
        SE_WINDOW_OBJECT,
        LABEL_SECURITY_INFORMATION,
        core::ptr::null_mut(),
        core::ptr::null_mut(),
        core::ptr::null_mut(),
        sacl,
    );
    if status != 0 {
        eprintln!("halo-box: labelling the {what} Low failed (win32 error {status})");
        exit(-1);
    }
}

/// A window station and desktop of the box's own, named for this helper's process.
///
/// A Low-integrity process has to attach to *some* desktop to load user32, and it cannot write to a
/// desktop labelled above Low. On an interactive session the default desktop happens to allow it;
/// under a service, a scheduled task or a CI runner it does not, and PowerShell dies in DLL init
/// (0xC0000142) before printing a character. A desktop created here, labelled Low, works in every
/// session — and it also means a box process cannot see, screenshot or message the windows on the
/// user's own desktop.
///
/// Returns the `station\desktop` string for STARTUPINFO. The handles are deliberately leaked: they
/// must outlive the child, and the helper exits when the child does.
unsafe fn private_desktop() -> Vec<u16> {
    // Authenticated users and SYSTEM may use them; the Low label goes on after creation.
    let mut attributes = SecurityAttributes {
        length: core::mem::size_of::<SecurityAttributes>() as Dword,
        descriptor: descriptor("D:(A;;GA;;;AU)(A;;GA;;;SY)"),
        inherit: FALSE,
    };

    // Unnamed, as Chromium's sandbox does it: naming one needs rights an ordinary user lacks in the
    // session's namespace. The system picks a name, which is read back for STARTUPINFO.
    let station = CreateWindowStationW(core::ptr::null(), 0, WINSTA_ALL_ACCESS | 0x000E_0000, &mut attributes);
    if station.is_null() {
        fail("CreateWindowStation");
    }
    let mut buffer = [0u16; 256];
    let mut needed: Dword = 0;
    if GetUserObjectInformationW(station, UOI_NAME, buffer.as_mut_ptr() as *mut _, (buffer.len() * 2) as Dword, &mut needed) == FALSE {
        fail("GetUserObjectInformation(station name)");
    }
    let name = String::from_utf16_lossy(&buffer[..buffer.iter().position(|&c| c == 0).unwrap_or(0)]);
    label_low(station, "window station");
    // A desktop is created in the calling process's window station, so switch to ours for the call.
    let previous = GetProcessWindowStation();
    if SetProcessWindowStation(station) == FALSE {
        fail("SetProcessWindowStation");
    }
    let desktop_name = wide("box");
    let desktop = CreateDesktopW(
        desktop_name.as_ptr(),
        core::ptr::null(),
        core::ptr::null_mut(),
        0,
        GENERIC_ALL,
        &mut attributes,
    );
    SetProcessWindowStation(previous);
    if desktop.is_null() {
        fail("CreateDesktop");
    }
    label_low(desktop, "desktop");
    wide(&format!("{name}\\box"))
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn fail(what: &str) -> ! {
    // On the caller's stderr, in the shape the rest of Halo's tool output uses, so a failure to
    // build the boundary reads as a refusal rather than as a mysterious empty result.
    eprintln!("halo-box: {what} failed (win32 error {})", unsafe { GetLastError() });
    exit(-1);
}

/// The token the command runs under: ours, minus privileges, minus admin, at Low integrity.
unsafe fn confined_token() -> Handle {
    let mut own: Handle = NULL;
    if OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_NEEDED, &mut own) == FALSE {
        fail("OpenProcessToken");
    }

    // Deny-only Administrators. An elevated Halo must not hand a bot its elevation, and the check
    // costs nothing when Halo is not elevated: the group is simply not present.
    let mut admins: *mut core::ffi::c_void = core::ptr::null_mut();
    let admins_sid = wide("S-1-5-32-544");
    let mut disable = [SidAndAttributes { sid: core::ptr::null_mut(), attributes: 0 }];
    let disable_count = if ConvertStringSidToSidW(admins_sid.as_ptr(), &mut admins) != FALSE {
        disable[0].sid = admins;
        1
    } else {
        0
    };

    let mut restricted: Handle = NULL;
    if CreateRestrictedToken(
        own,
        DISABLE_MAX_PRIVILEGE,
        disable_count,
        disable.as_mut_ptr(),
        0,
        core::ptr::null_mut(),
        0,
        core::ptr::null_mut(),
        &mut restricted,
    ) == FALSE
    {
        fail("CreateRestrictedToken");
    }
    CloseHandle(own);

    // A restricted token is still a Medium-integrity token, which can write anywhere the user can.
    // Lowering it is the step that turns "fewer privileges" into "cannot change my files".
    let mut primary: Handle = NULL;
    if DuplicateTokenEx(
        restricted,
        TOKEN_ALL_NEEDED,
        core::ptr::null_mut(),
        SECURITY_IMPERSONATION,
        TOKEN_PRIMARY,
        &mut primary,
    ) == FALSE
    {
        fail("DuplicateTokenEx");
    }
    CloseHandle(restricted);

    let mut low: *mut core::ffi::c_void = core::ptr::null_mut();
    let low_sid = wide("S-1-16-4096"); // SECURITY_MANDATORY_LOW_RID
    if ConvertStringSidToSidW(low_sid.as_ptr(), &mut low) == FALSE {
        fail("ConvertStringSidToSid(low)");
    }
    let mut label = TokenMandatoryLabel {
        label: SidAndAttributes { sid: low, attributes: SE_GROUP_INTEGRITY },
    };
    if SetTokenInformation(
        primary,
        TOKEN_INTEGRITY_LEVEL,
        &mut label as *mut _ as *mut core::ffi::c_void,
        core::mem::size_of::<TokenMandatoryLabel>() as Dword + 68,
    ) == FALSE
    {
        fail("SetTokenInformation(integrity)");
    }

    primary
}

/// A job the child cannot outlive, cannot fork out of, and cannot allocate the machine away inside.
unsafe fn bounded_job() -> Handle {
    let job = CreateJobObjectW(core::ptr::null_mut(), core::ptr::null());
    if job.is_null() {
        fail("CreateJobObject");
    }
    let mut limits: JobObjectExtendedLimitInformation = core::mem::zeroed();
    limits.basic_limit_information.limit_flags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    limits.basic_limit_information.active_process_limit = MAX_PROCESSES;
    limits.process_memory_limit = MAX_PROCESS_MEMORY;
    if SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        &mut limits as *mut _ as *mut core::ffi::c_void,
        core::mem::size_of::<JobObjectExtendedLimitInformation>() as Dword,
    ) == FALSE
    {
        fail("SetInformationJobObject");
    }
    job
}

struct Args {
    cwd: String,
    timeout_ms: Dword,
    command: String,
}

fn parse() -> Args {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut cwd = String::new();
    let mut timeout_ms = INFINITE;
    let mut command = String::new();
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--cwd" => {
                i += 1;
                cwd = argv.get(i).cloned().unwrap_or_default();
            }
            "--timeout-ms" => {
                i += 1;
                timeout_ms = argv.get(i).and_then(|v| v.parse().ok()).unwrap_or(INFINITE);
            }
            "--" => {
                // Everything after `--` is the command, joined back exactly as it arrived. The
                // caller passes it as one argument, so this is a join of one in practice.
                command = argv[i + 1..].join(" ");
                break;
            }
            other => {
                eprintln!("halo-box: unknown argument {other}");
                exit(-1);
            }
        }
        i += 1;
    }
    if command.trim().is_empty() {
        eprintln!("halo-box: usage: halo-box --cwd <dir> [--timeout-ms N] -- <command>");
        exit(-1);
    }
    Args { cwd, timeout_ms, command }
}

fn main() {
    let args = parse();
    unsafe {
        let token = confined_token();
        let job = bounded_job();

        // The child writes straight to our own stdout and stderr, so whatever spawned this helper
        // reads the command's output exactly as it read PowerShell's before the helper existed.
        let mut startup: StartupInfoW = core::mem::zeroed();
        startup.cb = core::mem::size_of::<StartupInfoW>() as Dword;
        startup.flags = STARTF_USESTDHANDLES;
        startup.std_input = GetStdHandle(STD_INPUT_HANDLE);
        startup.std_output = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.std_error = GetStdHandle(STD_ERROR_HANDLE);
        let mut desktop = private_desktop();
        startup.desktop = desktop.as_mut_ptr();

        // The user's %TEMP% is Medium integrity, so every tool that writes a scratch file there
        // (Add-Type, pip, npm, compilers) failed inside the box. The child inherits our environment,
        // so pointing TEMP and TMP at a folder inside the box fixes all of them at once.
        if !args.cwd.is_empty() {
            let scratch = format!("{}\\.tmp", args.cwd.trim_end_matches('\\'));
            if std::fs::create_dir_all(&scratch).is_ok() {
                std::env::set_var("TEMP", &scratch);
                std::env::set_var("TMP", &scratch);
            }
        }

        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let shell = format!("{system_root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        // -NoProfile matters twice: speed, and a profile script is a place somebody could put
        // something that runs before every command the boundary was built to contain.
        let mut command_line = wide(&format!(
            "\"{shell}\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command {}",
            args.command
        ));
        let application = wide(&shell);
        let cwd = if args.cwd.is_empty() { None } else { Some(wide(&args.cwd)) };

        let mut info: ProcessInformation = core::mem::zeroed();
        // Suspended, so the job owns it before its first instruction: a process that runs even
        // briefly outside the job could spawn a child that outlives the limits.
        if CreateProcessAsUserW(
            token,
            application.as_ptr(),
            command_line.as_mut_ptr(),
            core::ptr::null_mut(),
            core::ptr::null_mut(),
            TRUE,
            CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
            core::ptr::null_mut(),
            cwd.as_ref().map_or(core::ptr::null(), |c| c.as_ptr()),
            &mut startup,
            &mut info,
        ) == FALSE
        {
            fail("CreateProcessAsUser");
        }

        if AssignProcessToJobObject(job, info.process) == FALSE {
            TerminateProcess(info.process, 1);
            fail("AssignProcessToJobObject");
        }
        ResumeThread(info.thread);

        let waited = WaitForSingleObject(info.process, args.timeout_ms);
        if waited == WAIT_TIMEOUT {
            eprintln!("halo-box: timed out after {}ms", args.timeout_ms);
            TerminateProcess(info.process, 1);
            WaitForSingleObject(info.process, 5000);
            exit(124);
        }

        let mut code: Dword = 0;
        GetExitCodeProcess(info.process, &mut code);
        // An NTSTATUS error means the shell died before running anything (a DLL that would not
        // initialise, an access violation in start-up). Without this line the bot sees an empty
        // result and has no idea the command never ran.
        if code >= 0xC000_0000 {
            eprintln!("halo-box: the shell failed to start (NTSTATUS 0x{code:08X}); the command did not run");
        }
        CloseHandle(info.thread);
        CloseHandle(info.process);
        CloseHandle(job);
        CloseHandle(token);
        exit(code as i32);
    }
}
