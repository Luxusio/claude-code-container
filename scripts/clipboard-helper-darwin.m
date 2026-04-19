// clipboard-helper-darwin.m - Persistent clipboard reader for macOS
// Reads commands from stdin, outputs JSON + marker to stdout.
// Protocol: identical to Windows PowerShell clipboard reader.
//
// Build: cc -framework AppKit -framework Foundation -O2 -o clipboard-helper-darwin clipboard-helper-darwin.m
// Usage: echo READ | ./clipboard-helper-darwin

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

static const char *MARKER = "<<<CCC_CB_DONE>>>";

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        // Disable buffering for real-time output
        setvbuf(stdout, NULL, _IONBF, 0);

        char buf[256];
        while (fgets(buf, sizeof(buf), stdin)) {
            @autoreleasepool {
                NSPasteboard *pb = [NSPasteboard generalPasteboard];
                NSMutableDictionary *result = [NSMutableDictionary new];
                NSMutableArray *targets = [NSMutableArray new];

                // Read PNG image data
                NSData *png = [pb dataForType:NSPasteboardTypePNG];
                if (png) {
                    [targets addObject:@"image/png"];
                    result[@"imagePng"] = [png base64EncodedStringWithOptions:0];
                }

                // Read text
                NSString *text = [pb stringForType:NSPasteboardTypeString];
                if (text) {
                    [targets addObject:@"text/plain"];
                    result[@"text"] = text;
                }

                result[@"targets"] = targets;

                NSData *json = [NSJSONSerialization dataWithJSONObject:result
                                                               options:0
                                                                 error:nil];
                if (json) {
                    NSString *jsonStr = [[NSString alloc] initWithData:json
                                                             encoding:NSUTF8StringEncoding];
                    printf("%s\n%s\n", jsonStr.UTF8String, MARKER);
                } else {
                    printf("{\"targets\":[]}\n%s\n", MARKER);
                }
            }
        }
    }
    return 0;
}
