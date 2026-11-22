import CoreImage
import CoreImage.CIFilterBuiltins
import CoreGraphics

/// A QR code as a crisp bitmap (CoreImage CIQRCodeGenerator, medium error correction), scaled by whole pixels. Nil for empty text.
public func qrImage(_ text: String, scale: Int = 8) -> CGImage? {
    guard !text.isEmpty else { return nil }
    let f = CIFilter.qrCodeGenerator()
    f.message = Data(text.utf8)
    f.correctionLevel = "M"
    guard let out = f.outputImage else { return nil }
    let scaled = out.samplingNearest().transformed(by: CGAffineTransform(scaleX: CGFloat(scale), y: CGFloat(scale)))
    return CIContext(options: [.useSoftwareRenderer: true]).createCGImage(scaled, from: scaled.extent)
}
