//! Runs a bot's shell command inside that bot's own AppContainer.
//!
//! WHY THIS EXISTS. `Shell` in Halo was real PowerShell with the user's full rights, and the box was
//! a folder rather than a boundary: `host/policy.ts` can make an escape *visible* by reading the
//! command text, but a determined model writes the same command a hundred ways and no list catches
//! them all. The boundary has to be the process, not the regex.
//!
//! An earlier version lowered the child to Low integrity. That stopped writes outside the box but not
//! reads, not the network, and not one bot writing into another bot's box, because every box was
//! labelled Low. A prompt injection could still read `~/.ssh` and send it anywhere. An AppContainer
//! closes all three, because Windows checks every access twice: once as the user, and once more as
//! the container, which is granted almost nothing.
//!
//! WHAT IT DOES, in order:
//!
//!   1. An AppContainer profile per box, named from the box path, so each bot is its own security
//!      principal (`S-1-15-2-вЂ¦`). The container can read Windows and Program Files and nothing of
//!      the user's: not their profile, not Halo's data, not another bot's box.
//!   2. The box folder granted to that container alone. The caller has already labelled it Low
//!      integrity (an AppContainer process runs at Low, and no-write-up applies to it too).
//!   3. No network capability unless `--network` is passed. Without one the container cannot open
//!      a socket to the internet or the LAN, so nothing it read can be sent out from the shell.
//!   4. A job object holding the child, with kill-on-close, a process cap and a memory cap.
//!   5. A window station and desktop of its own, labelled Low, so the child starts in any session
//!      and cannot see or message the windows on the user's desktop.
//!
//! WHAT IT IS NOT. The browser is a different surface with its own gate; so is `ExternalShell`,
//! which runs with the user's rights on purpose once they approve it. And a container can still read
//! what Windows lets every app package read вЂ” the OS and installed programs.
//!
//! Usage: `halo-box.exe --box <dir> [--cwd <dir>] [--network] [--timeout-ms N] -- <command вЂ¦>`
//!        `halo-box.exe --forget <dir>` deletes the box's container profile (the bot was deleted).
//! The command is handed to `powershell.exe -NoProfile -NonInteractive`. stdout and stderr are the
//! parent's own handles, so the caller reads them exactly as it read PowerShell's before.

#![cfg(windows)]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::process::exit;

type Handle = *mut core::ffi::c_void;
type Psid = *mut core::ffi::c_void;
type Dword = u32;
type Bool = i32;
type Hresult = i32;

const TRUE: Bool = 1;
const FALSE: Bool = 0;

const CREATE_UNICODE_ENVIRONMENT: Dword = 0x0000_0400;
const CREATE_SUSPENDED: Dword = 0x0000_0004;
const CREATE_NO_WINDOW: Dword = 0x0800_0000;
const EXTENDED_STARTUPINFO_PRESENT: Dword = 0x0008_0000;
const STARTF_USESTDHANDLES: Dword = 0x0000_0100;
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_0009;

const STD_INPUT_HANDLE: Dword = -10i32 as Dword;
const STD_OUTPUT_HANDLE: Dword = -11i32 as Dword;
const STD_ERROR_HANDLE: Dword = -12i32 as Dword;

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: Dword = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x0000_2000;
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: Dword = 0x0000_0008;
const JOB_OBJECT_LIMIT_PROCESS_MEMORY: Dword = 0x0000_0100;

const INFINITE: Dword = 0xFFFF_FFFF;
const WAIT_TIMEOUT: Dword = 258;

const GENERIC_ALL: Dword = 0x1000_0000;
const FILE_ALL_ACCESS: Dword = 0x001F_01FF;
const WINSTA_ALL_ACCESS: Dword = 0x0000_037F;
const UOI_NAME: i32 = 2;
const SDDL_REVISION_1: Dword = 1;
const SE_FILE_OBJECT: Dword = 1;
const SE_WINDOW_OBJECT: Dword = 7;
const DACL_SECURITY_INFORMATION: Dword = 0x0000_0004;
const LABEL_SECURITY_INFORMATION: Dword = 0x0000_0010;
const GRANT_ACCESS: Dword = 1;
const SUB_CONTAINERS_AND_OBJECTS_INHERIT: Dword = 3;
const TRUSTEE_IS_SID: Dword = 0;
const TRUSTEE_IS_UNKNOWN: Dword = 0;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACL_SIZE_INFORMATION_CLASS: Dword = 2;
const SE_GROUP_ENABLED: Dword = 0x0000_0004;
const HRESULT_ALREADY_EXISTS: Hresult = 0x8007_00B7u32 as Hresult;

/// The bot's shell may fan out вЂ” npm spawns node, git spawns ssh вЂ” but not without limit.
const MAX_PROCESSES: Dword = 64;
/// Enough for a real toolchain, not enough to take the machine down by allocating.
const MAX_PROCESS_MEMORY: usize = 4 * 1024 * 1024 * 1024;

/// internetClient and privateNetworkClientServer: outbound to the internet and the LAN.
const NETWORK_CAPABILITIES: [&str; 2] = ["S-1-15-3-1", "S-1-15-3-3"];

#[repr(C)]
struct SidAndAttributes {
    sid: Psid,
    attributes: Dword,
}

#[repr(C)]
struct SecurityCapabilities {
    app_container_sid: Psid,
    capabilities: *mut SidAndAttributes,
    capability_count: Dword,
    reserved: Dword,
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
struct StartupInfoExW {
    startup_info: StartupInfoW,
    attribute_list: *mut core::ffi::c_void,
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

#[repr(C)]
struct SecurityAttributes {
    length: Dword,
    descriptor: *mut core::ffi::c_void,
    inherit: Bool,
}

#[repr(C)]
struct TrusteeW {
    multiple_trustee: *mut TrusteeW,
    multiple_trustee_operation: Dword,
    trustee_form: Dword,
    trustee_type: Dword,
    name: *mut u16,
}

#[repr(C)]
struct ExplicitAccessW {
    access_permissions: Dword,
    access_mode: Dword,
    inheritance: Dword,
    trustee: TrusteeW,
}

#[repr(C)]
struct AclSizeInformation {
    ace_count: Dword,
    acl_bytes_in_use: Dword,
    acl_bytes_free: Dword,
}

#[repr(C)]
struct AceHeader {
    ace_type: u8,
    ace_flags: u8,
    ace_size: u16,
}

#[repr(C)]
struct AccessAllowedAce {
    header: AceHeader,
    mask: Dword,
    sid_start: Dword,
}

#[link(name = "kernel32")]
extern "system" {
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
    fn LocalFree(memory: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    fn InitializeProcThreadAttributeList(list: *mut core::ffi::c_void, count: Dword, flags: Dword, size: *mut usize) -> Bool;
    fn UpdateProcThreadAttribute(
        list: *mut core::ffi::c_void,
        flags: Dword,
        attribute: usize,
        value: *mut core::ffi::c_void,
        size: usize,
        previous: *mut core::ffi::c_void,
        return_size: *mut usize,
    ) -> Bool;
    fn CreateProcessW(
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
}

#[link(name = "advapi32")]
extern "system" {
    fn ConvertStringSidToSidW(sid: *const u16, out: *mut Psid) -> Bool;
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
        owner: Psid,
        group: Psid,
        dacl: *mut core::ffi::c_void,
        sacl: *mut core::ffi::c_void,
    ) -> Dword;
    fn GetNamedSecurityInfoW(
        name: *const u16,
        object_type: Dword,
        information: Dword,
        owner: *mut Psid,
        group: *mut Psid,
        dacl: *mut *mut core::ffi::c_void,
        sacl: *mut *mut core::ffi::c_void,
        descriptor: *mut *mut core::ffi::c_void,
    ) -> Dword;
    fn SetNamedSecurityInfoW(
        name: *mut u16,
        object_type: Dword,
        information: Dword,
        owner: Psid,
        group: Psid,
        dacl: *mut core::ffi::c_void,
        sacl: *mut core::ffi::c_void,
    ) -> Dword;
    fn SetEntriesInAclW(count: Dword, entries: *mut ExplicitAccessW, old: *mut core::ffi::c_void, new: *mut *mut core::ffi::c_void) -> Dword;
    fn GetAclInformation(acl: *mut core::ffi::c_void, info: *mut core::ffi::c_void, len: Dword, class: Dword) -> Bool;
    fn GetAce(acl: *mut core::ffi::c_void, index: Dword, ace: *mut *mut core::ffi::c_void) -> Bool;
    fn EqualSid(a: Psid, b: Psid) -> Bool;
    fn FreeSid(sid: Psid) -> *mut core::ffi::c_void;
}

#[link(name = "userenv")]
extern "system" {
    fn CreateAppContainerProfile(
        name: *const u16,
        display_name: *const u16,
        description: *const u16,
        capabilities: *mut SidAndAttributes,
        capability_count: Dword,
        sid: *mut Psid,
    ) -> Hresult;
    fn DeriveAppContainerSidFromAppContainerName(name: *const u16, sid: *mut Psid) -> Hresult;
    fn DeleteAppContainerProfile(name: *const u16) -> Hresult;
}

#[link(name = "user32")]
extern "system" {
    fn GetProcessWindowStation() -> Handle;
    fn SetProcessWindowStation(station: Handle) -> Bool;
    fn GetUserObjectInformationW(object: Handle, index: i32, info: *mut core::ffi::c_void, length: Dword, needed: *mut Dword) -> Bool;
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

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn fail(what: &str) -> ! {
    // On the caller's stderr, in the shape the rest of Halo's tool output uses, so a failure to
    // build the boundary reads as a refusal rather than as a mysterious empty result.
    eprintln!("halo-box: {what} failed (win32 error {})", unsafe { GetLastError() });
    exit(-1);
}

fn fail_with(what: &str, code: impl core::fmt::LowerHex) -> ! {
    eprintln!("halo-box: {what} failed (0x{code:08x})");
    exit(-1);
}

/// The container's name, derived from the box's path so the same box always gets the same one.
///
/// FNV-1a over the lower-cased path: stable across runs and machines, needs no crate, and 64 bits is
/// ample for the handful of boxes one user has. Names are capped at 64 characters by Windows.
fn container_name(box_dir: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in box_dir.trim_end_matches('\\').to_lowercase().bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("Halo.Box.{hash:016x}")
}

/// The container's SID, creating its profile the first time this box is used.
unsafe fn container_sid(name: &str) -> Psid {
    let name_w = wide(name);
    let display = wide("Halo Bot box");
    let mut sid: Psid = core::ptr::null_mut();
    let created = CreateAppContainerProfile(
        name_w.as_ptr(),
        display.as_ptr(),
        display.as_ptr(),
        core::ptr::null_mut(),
        0,
        &mut sid,
    );
    if created == HRESULT_ALREADY_EXISTS {
        let derived = DeriveAppContainerSidFromAppContainerName(name_w.as_ptr(), &mut sid);
        if derived < 0 {
            fail_with("DeriveAppContainerSidFromAppContainerName", derived);
        }
    } else if created < 0 {
        fail_with("CreateAppContainerProfile", created);
    }
    sid
}

/// Grants the container full access to the box folder, once.
///
/// Checked before it is written: SetNamedSecurityInfo propagates to every file under the folder, and
/// a box with a node_modules in it would pay for that on every command.
unsafe fn grant_box(box_dir: &str, sid: Psid) {
    let path = wide(box_dir);
    let mut dacl: *mut core::ffi::c_void = core::ptr::null_mut();
    let mut descriptor: *mut core::ffi::c_void = core::ptr::null_mut();
    let status = GetNamedSecurityInfoW(
        path.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        core::ptr::null_mut(),
        core::ptr::null_mut(),
        &mut dacl,
        core::ptr::null_mut(),
        &mut descriptor,
    );
    if status != 0 {
        fail_with("GetNamedSecurityInfo(box)", status);
    }

    if !dacl.is_null() {
        let mut size: AclSizeInformation = core::mem::zeroed();
        if GetAclInformation(
            dacl,
            &mut size as *mut _ as *mut core::ffi::c_void,
            core::mem::size_of::<AclSizeInformation>() as Dword,
            ACL_SIZE_INFORMATION_CLASS,
        ) != FALSE
        {
            for index in 0..size.ace_count {
                let mut ace: *mut core::ffi::c_void = core::ptr::null_mut();
                if GetAce(dacl, index, &mut ace) == FALSE {
                    continue;
                }
                let allowed = ace as *mut AccessAllowedAce;
                if (*allowed).header.ace_type == ACCESS_ALLOWED_ACE_TYPE
                    && (*allowed).mask & FILE_ALL_ACCESS == FILE_ALL_ACCESS
                    && EqualSid(&mut (*allowed).sid_start as *mut Dword as Psid, sid) != FALSE
                {
                    LocalFree(descriptor);
                    return;
                }
            }
        }
    }

    let mut entry = ExplicitAccessW {
        access_permissions: FILE_ALL_ACCESS,
        access_mode: GRANT_ACCESS,
        inheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        trustee: TrusteeW {
            multiple_trustee: core::ptr::null_mut(),
            multiple_trustee_operation: 0,
            trustee_form: TRUSTEE_IS_SID,
            trustee_type: TRUSTEE_IS_UNKNOWN,
            name: sid as *mut u16,
        },
    };
    let mut merged: *mut core::ffi::c_void = core::ptr::null_mut();
    let status = SetEntriesInAclW(1, &mut entry, dacl, &mut merged);
    if status != 0 {
        fail_with("SetEntriesInAcl(box)", status);
    }
    let mut path = path;
    let status = SetNamedSecurityInfoW(
        path.as_mut_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        core::ptr::null_mut(),
        core::ptr::null_mut(),
        merged,
        core::ptr::null_mut(),
    );
    if status != 0 {
        fail_with("SetNamedSecurityInfo(box)", status);
    }
    LocalFree(merged);
    LocalFree(descriptor);
}

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

/// A window station and desktop of the box's own.
///
/// A Low-integrity process has to attach to *some* desktop to load user32, and it cannot write to a
/// desktop labelled above Low. On an interactive session the default desktop happens to allow it;
/// under a service, a scheduled task or a CI runner it does not, and PowerShell dies in DLL init
/// (0xC0000142) before printing a character. A desktop created here, labelled Low and open to app
/// containers, works in every session вЂ” and a box process cannot see, screenshot or message the
/// windows on the user's own desktop.
///
/// Returns the `station\desktop` string for STARTUPINFO. The handles are deliberately leaked: they
/// must outlive the child, and the helper exits when the child does.
unsafe fn private_desktop() -> Vec<u16> {
    // Authenticated users, SYSTEM and every app container may use them; the Low label goes on after
    // creation.
    let mut attributes = SecurityAttributes {
        length: core::mem::size_of::<SecurityAttributes>() as Dword,
        descriptor: descriptor("D:(A;;GA;;;AU)(A;;GA;;;SY)(A;;GA;;;AC)"),
        inherit: FALSE,
    };

    // Unnamed, as Chromium's sandbox does it: naming one needs rights an ordinary user lacks in the
    // session's namespace. The system picks a name, which is read back for STARTUPINFO.
    let station = CreateWindowStationW(core::ptr::null(), 0, WINSTA_ALL_ACCESS | 0x000E_0000, &mut attributes);
    if station.is_null() {
        fail("CreateWindowStation");
    }
    label_low(station, "window station");
    let mut buffer = [0u16; 256];
    let mut needed: Dword = 0;
    if GetUserObjectInformationW(station, UOI_NAME, buffer.as_mut_ptr() as *mut _, (buffer.len() * 2) as Dword, &mut needed) == FALSE {
        fail("GetUserObjectInformation(station name)");
    }
    let name = String::from_utf16_lossy(&buffer[..buffer.iter().position(|&c| c == 0).unwrap_or(0)]);

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

/// Scratch space and PowerShell's module cache, both inside the box.
///
/// The user's %TEMP% is out of the container's reach, so every tool that writes a scratch file
/// there (Add-Type, pip, npm, compilers) would fail. PowerShell also resolves commands from a
/// module-analysis cache under %LOCALAPPDATA%; where it cannot keep one it rebuilds the analysis on
/// every command (~20-30 s on a machine with many modules). The cache is seeded once from the
/// user's own, which this helper вЂ” not the container вЂ” can read.
fn prepare_scratch(box_dir: &str) {
    let scratch = format!("{}\\.tmp", box_dir.trim_end_matches('\\'));
    if std::fs::create_dir_all(&scratch).is_err() {
        return;
    }
    std::env::set_var("TEMP", &scratch);
    std::env::set_var("TMP", &scratch);
    let cache = format!("{scratch}\\ModuleAnalysisCache");
    if !std::path::Path::new(&cache).exists() {
        let seed = std::env::var("PSModuleAnalysisCachePath").ok().or_else(|| {
            std::env::var("LOCALAPPDATA")
                .ok()
                .map(|local| format!("{local}\\Microsoft\\Windows\\PowerShell\\ModuleAnalysisCache"))
        });
        if let Some(seed) = seed {
            let _ = std::fs::copy(seed, &cache);
        }
    }
    std::env::set_var("PSModuleAnalysisCachePath", cache);
}

/// The PowerShell prelude that puts the command in its working directory.
///
/// PowerShell validates a location by listing every folder above it to get the path's casing, and
/// the container may not list the user's profile — so `Set-Location` into the box is refused and
/// PowerShell starts in C:\, where every relative path then lands. A drive rooted at the box has
/// only one folder to check, the box itself. Absolute paths inside the box still work, and native
/// programs get the real path as their working directory.
fn box_location(box_dir: &str, cwd: &str) -> String {
    let root = box_dir.trim_end_matches('\\');
    let inside = cwd
        .trim_end_matches('\\')
        .get(root.len()..)
        .filter(|_| cwd.to_lowercase().starts_with(&root.to_lowercase()))
        .unwrap_or("")
        .trim_start_matches('\\');
    let quote = |s: &str| s.replace('\'', "''");
    format!(
        "$null = New-PSDrive -Name Box -PSProvider FileSystem -Root '{}'; Set-Location -LiteralPath 'Box:\\{}';",
        quote(root),
        quote(inside)
    )
}

struct Args {
    box_dir: String,
    cwd: String,
    network: bool,
    forget: Option<String>,
    timeout_ms: Dword,
    command: String,
}

fn parse() -> Args {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut args = Args {
        box_dir: String::new(),
        cwd: String::new(),
        network: false,
        forget: None,
        timeout_ms: INFINITE,
        command: String::new(),
    };
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--box" => {
                i += 1;
                args.box_dir = argv.get(i).cloned().unwrap_or_default();
            }
            "--cwd" => {
                i += 1;
                args.cwd = argv.get(i).cloned().unwrap_or_default();
            }
            "--network" => args.network = true,
            "--forget" => {
                i += 1;
                args.forget = argv.get(i).cloned();
            }
            "--timeout-ms" => {
                i += 1;
                args.timeout_ms = argv.get(i).and_then(|v| v.parse().ok()).unwrap_or(INFINITE);
            }
            "--" => {
                // Everything after `--` is the command, joined back exactly as it arrived. The
                // caller passes it as one argument, so this is a join of one in practice.
                args.command = argv[i + 1..].join(" ");
                break;
            }
            other => {
                eprintln!("halo-box: unknown argument {other}");
                exit(-1);
            }
        }
        i += 1;
    }
    if args.forget.is_some() {
        return args;
    }
    if args.box_dir.is_empty() {
        args.box_dir = args.cwd.clone();
    }
    if args.cwd.is_empty() {
        args.cwd = args.box_dir.clone();
    }
    if args.box_dir.is_empty() || args.command.trim().is_empty() {
        eprintln!("halo-box: usage: halo-box --box <dir> [--cwd <dir>] [--network] [--timeout-ms N] -- <command>");
        exit(-1);
    }
    args
}

fn main() {
    let args = parse();
    unsafe {
        if let Some(box_dir) = args.forget {
            // A deleted bot's container goes with it; a missing one is not an error.
            let name = wide(&container_name(&box_dir));
            DeleteAppContainerProfile(name.as_ptr());
            exit(0);
        }

        let sid = container_sid(&container_name(&args.box_dir));
        grant_box(&args.box_dir, sid);
        prepare_scratch(&args.box_dir);
        let job = bounded_job();

        let mut capabilities: Vec<SidAndAttributes> = Vec::new();
        if args.network {
            for text in NETWORK_CAPABILITIES {
                let text = wide(text);
                let mut capability: Psid = core::ptr::null_mut();
                if ConvertStringSidToSidW(text.as_ptr(), &mut capability) == FALSE {
                    fail("ConvertStringSidToSid(capability)");
                }
                capabilities.push(SidAndAttributes { sid: capability, attributes: SE_GROUP_ENABLED });
            }
        }
        let mut security = SecurityCapabilities {
            app_container_sid: sid,
            capabilities: if capabilities.is_empty() { core::ptr::null_mut() } else { capabilities.as_mut_ptr() },
            capability_count: capabilities.len() as Dword,
            reserved: 0,
        };

        let mut size: usize = 0;
        InitializeProcThreadAttributeList(core::ptr::null_mut(), 1, 0, &mut size);
        let mut list = vec![0u8; size];
        let list_ptr = list.as_mut_ptr() as *mut core::ffi::c_void;
        if InitializeProcThreadAttributeList(list_ptr, 1, 0, &mut size) == FALSE {
            fail("InitializeProcThreadAttributeList");
        }
        if UpdateProcThreadAttribute(
            list_ptr,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            &mut security as *mut _ as *mut core::ffi::c_void,
            core::mem::size_of::<SecurityCapabilities>(),
            core::ptr::null_mut(),
            core::ptr::null_mut(),
        ) == FALSE
        {
            fail("UpdateProcThreadAttribute(security capabilities)");
        }

        // The child writes straight to our own stdout and stderr, so whatever spawned this helper
        // reads the command's output exactly as it read PowerShell's before the helper existed.
        let mut startup: StartupInfoExW = core::mem::zeroed();
        startup.startup_info.cb = core::mem::size_of::<StartupInfoExW>() as Dword;
        startup.startup_info.flags = STARTF_USESTDHANDLES;
        startup.startup_info.std_input = GetStdHandle(STD_INPUT_HANDLE);
        startup.startup_info.std_output = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.startup_info.std_error = GetStdHandle(STD_ERROR_HANDLE);
        let mut desktop = private_desktop();
        startup.startup_info.desktop = desktop.as_mut_ptr();
        startup.attribute_list = list_ptr;

        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let shell = format!("{system_root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        // -NoProfile matters twice: speed, and a profile script is a place somebody could put
        // something that runs before every command the boundary was built to contain.
        let mut command_line = wide(&format!(
            "\"{shell}\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command {} {}",
            box_location(&args.box_dir, &args.cwd),
            args.command
        ));
        let application = wide(&shell);
        let cwd = wide(&args.cwd);

        let mut info: ProcessInformation = core::mem::zeroed();
        // Suspended, so the job owns it before its first instruction: a process that runs even
        // briefly outside the job could spawn a child that outlives the limits.
        if CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            core::ptr::null_mut(),
            core::ptr::null_mut(),
            TRUE,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
            core::ptr::null_mut(),
            cwd.as_ptr(),
            &mut startup.startup_info,
            &mut info,
        ) == FALSE
        {
            fail("CreateProcess");
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
        for capability in capabilities {
            LocalFree(capability.sid);
        }
        FreeSid(sid);
        exit(code as i32);
    }
}
